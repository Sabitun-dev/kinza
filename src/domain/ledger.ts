import type { DbOrTx } from '../core/db.ts';
import { fromDbDate, localDate } from '../shared/dates.ts';

// The debt ledger of a shop.
//   Debits  = delivered orders (and opening balances), amount = order.total
//   Credits = payments and returns (not voided)
// Allocations say which credit covers which order. They are recomputed for the whole shop after
// every change, oldest order first, so the result is always consistent and easy to check.

export interface Debit {
  id: number;
  total: number;
  date: Date;
}
export interface Credit {
  kind: 'payment' | 'return';
  id: number;
  amount: number;
  date: Date;
  targetOrderId: number | null;
}
export interface AllocationRow {
  orderId: number;
  kind: 'payment' | 'return';
  creditId: number;
  amount: number;
}

/** Pure allocation: targeted order first, then oldest-first. Leftover = shop credit (overpayment). */
export function allocate(debits: Debit[], credits: Credit[]) {
  const orderedDebits = [...debits].sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);
  const remaining = new Map(orderedDebits.map((d) => [d.id, d.total]));
  const rows: AllocationRow[] = [];
  let unallocated = 0;
  const orderedCredits = [...credits].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || (a.kind === b.kind ? a.id - b.id : a.kind === 'return' ? -1 : 1),
  );
  for (const c of orderedCredits) {
    let left = c.amount;
    const take = (orderId: number) => {
      const r = remaining.get(orderId) ?? 0;
      const amt = Math.min(r, left);
      if (amt <= 0) return;
      remaining.set(orderId, r - amt);
      left -= amt;
      const prev = rows.find((x) => x.orderId === orderId && x.kind === c.kind && x.creditId === c.id);
      if (prev) prev.amount += amt;
      else rows.push({ orderId, kind: c.kind, creditId: c.id, amount: amt });
    };
    if (c.targetOrderId && remaining.has(c.targetOrderId)) take(c.targetOrderId);
    for (const d of orderedDebits) {
      if (left <= 0) break;
      take(d.id);
    }
    unallocated += left;
  }
  return { rows, unallocated, remaining };
}

/** Recomputes allocations and the cached paid/returned amounts on the shop's orders. */
export async function reallocateShop(db: DbOrTx, shopId: number) {
  const [orders, payments, returns] = await Promise.all([
    db.order.findMany({ where: { shopId, status: 'DELIVERED' }, select: { id: true, total: true, deliveredAt: true, createdAt: true } }),
    db.payment.findMany({ where: { shopId, voidedAt: null }, select: { id: true, amount: true, paidAt: true, targetOrderId: true } }),
    db.return.findMany({ where: { shopId, voidedAt: null }, select: { id: true, total: true, date: true, orderId: true } }),
  ]);
  const { rows, unallocated } = allocate(
    orders.map((o) => ({ id: o.id, total: o.total, date: o.deliveredAt ?? o.createdAt })),
    [
      ...payments.map((p) => ({ kind: 'payment' as const, id: p.id, amount: p.amount, date: p.paidAt, targetOrderId: p.targetOrderId })),
      ...returns.map((r) => ({ kind: 'return' as const, id: r.id, amount: r.total, date: r.date, targetOrderId: r.orderId })),
    ],
  );
  await db.allocation.deleteMany({ where: { order: { shopId } } });
  if (rows.length) {
    await db.allocation.createMany({
      data: rows.map((r) => ({
        orderId: r.orderId,
        amount: r.amount,
        paymentId: r.kind === 'payment' ? r.creditId : null,
        returnId: r.kind === 'return' ? r.creditId : null,
      })),
    });
  }
  // Update caches on every order of this shop (including non-delivered → 0)
  const paid = new Map<number, number>();
  const returned = new Map<number, number>();
  for (const r of rows) {
    const m = r.kind === 'payment' ? paid : returned;
    m.set(r.orderId, (m.get(r.orderId) ?? 0) + r.amount);
  }
  const all = await db.order.findMany({ where: { shopId }, select: { id: true, paidAmount: true, returnedAmount: true } });
  for (const o of all) {
    const p = paid.get(o.id) ?? 0;
    const r = returned.get(o.id) ?? 0;
    if (o.paidAmount !== p || o.returnedAmount !== r) {
      await db.order.update({ where: { id: o.id }, data: { paidAmount: p, returnedAmount: r } });
    }
  }
  return { unallocated };
}

export type PayStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERDUE';

export function outstanding(o: { total: number; paidAmount: number; returnedAmount: number }) {
  return Math.max(0, o.total - o.paidAmount - o.returnedAmount);
}

export function payStatus(
  o: { status: string; total: number; paidAmount: number; returnedAmount: number; dueDate: Date | null },
  today: string,
): PayStatus | null {
  if (o.status !== 'DELIVERED') return null;
  const left = outstanding(o);
  if (left <= 0) return 'PAID';
  const due = fromDbDate(o.dueDate);
  if (due && due < today) return 'OVERDUE';
  return o.paidAmount + o.returnedAmount > 0 ? 'PARTIAL' : 'UNPAID';
}

export interface ShopBalance {
  shopId: number;
  debit: number; // delivered total
  credit: number; // paid + returned
  balance: number; // > 0 shop owes me, < 0 shop has credit
  overdue: number;
  oldestUnpaid: string | null; // local date of the oldest unpaid delivery
}

/** Balances for many shops in a few queries (lists, debtors). */
export async function shopBalances(db: DbOrTx, today: string, shopIds?: number[]): Promise<Map<number, ShopBalance>> {
  const where = shopIds ? { shopId: { in: shopIds } } : {};
  const [debits, pays, rets, open] = await Promise.all([
    db.order.groupBy({ by: ['shopId'], where: { ...where, status: 'DELIVERED' }, _sum: { total: true } }),
    db.payment.groupBy({ by: ['shopId'], where: { ...where, voidedAt: null }, _sum: { amount: true } }),
    db.return.groupBy({ by: ['shopId'], where: { ...where, voidedAt: null }, _sum: { total: true } }),
    db.order.findMany({
      where: { ...where, status: 'DELIVERED' },
      select: { shopId: true, total: true, paidAmount: true, returnedAmount: true, dueDate: true, deliveredAt: true },
    }),
  ]);
  const out = new Map<number, ShopBalance>();
  const get = (id: number) => {
    let b = out.get(id);
    if (!b) out.set(id, (b = { shopId: id, debit: 0, credit: 0, balance: 0, overdue: 0, oldestUnpaid: null }));
    return b;
  };
  for (const d of debits) get(d.shopId).debit += d._sum.total ?? 0;
  for (const p of pays) get(p.shopId).credit += p._sum.amount ?? 0;
  for (const r of rets) get(r.shopId).credit += r._sum.total ?? 0;
  for (const o of open) {
    const left = outstanding(o);
    if (left <= 0) continue;
    const b = get(o.shopId);
    const due = fromDbDate(o.dueDate);
    if (due && due < today) b.overdue += left;
    const d = o.deliveredAt ? localDate(o.deliveredAt) : null;
    if (d && (!b.oldestUnpaid || d < b.oldestUnpaid)) b.oldestUnpaid = d;
  }
  for (const b of out.values()) b.balance = b.debit - b.credit;
  if (shopIds) for (const id of shopIds) get(id);
  return out;
}
