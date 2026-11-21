import type { Ctx } from '../core/context.ts';
import type { Tx } from '../core/db.ts';
import { inTx } from '../core/db.ts';
import { audit } from '../core/audit.ts';
import { bad, forbidden, notFound } from '../core/errors.ts';
import { nextNumber, formatDocNumber } from '../core/counters.ts';
import { isOwner } from '../core/permissions.ts';
import type { PayMethod, ReturnCondition } from '../generated/prisma/enums.ts';
import { outstanding, reallocateShop, shopBalances } from './ledger.ts';
import { pricesForShop } from './pricing.ts';
import { averageCost, movement, WAREHOUSE, type Place } from './stock.ts';
import { bizInfo, esc, notifyOwners, sendDocumentToChat, shopParty, storeDocument } from './docs.ts';
import { receiptDocument, reconciliationDocument, returnDocument } from '../pdf/documents.ts';
import { daysBetween, localDate, localDateTime, startOfLocalDay, addDays } from '../shared/dates.ts';
import { formatMoney } from '../shared/money.ts';
import { t } from '../shared/i18n/index.ts';

export interface PaymentInput {
  shopId: number;
  amount: number;
  method: PayMethod;
  date?: string;
  targetOrderId?: number | null;
  comment?: string | null;
  idempotencyKey?: string;
}

export async function createPayment(ctx: Ctx, input: PaymentInput) {
  if (input.amount <= 0) throw bad("Summa 0 dan katta bo'lsin");
  if (input.idempotencyKey) {
    const dup = await ctx.db.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (dup) return { id: dup.id, duplicate: true };
  }
  const today = localDate(ctx.now());
  const date = input.date ?? today;
  if (date > today) throw bad("Sana kelajakda bo'lmasin");
  const result = await inTx(ctx.db, async (tx) => {
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: input.shopId } });
    if (input.targetOrderId) {
      const o = await tx.order.findFirst({ where: { id: input.targetOrderId, shopId: input.shopId } });
      if (!o) throw bad('Hujjat bu do‘konga tegishli emas');
    }
    const paidAt = date === today ? ctx.now() : localDateTime(date, '12:00');
    const pay = await tx.payment.create({
      data: {
        shopId: input.shopId,
        amount: input.amount,
        method: input.method,
        paidAt,
        receivedById: ctx.user.id,
        targetOrderId: input.targetOrderId ?? null,
        comment: input.comment || null,
        handedOverAt: isOwner(ctx.user) ? ctx.now() : null,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
    const { unallocated } = await reallocateShop(tx, input.shopId);
    await audit(tx, ctx.user.id, 'payment.create', 'payment', pay.id, undefined, { shopId: input.shopId, amount: input.amount, method: input.method, targetOrderId: input.targetOrderId });
    const balance = (await shopBalances(tx, today, [input.shopId])).get(input.shopId)!.balance;

    // Short receipt PDF (can be shared with the shop)
    const year = Number(today.slice(0, 4));
    const n = await nextNumber(tx, 'RECEIPT', year);
    const number = formatDocNumber('KV', year, n, ctx.settings.numberDigits);
    const bytes = await receiptDocument({
      number,
      date,
      business: await bizInfo(tx, ctx.blobs, ctx.settings),
      shop: shopParty(shop),
      amount: input.amount,
      method: input.method,
      receivedBy: ctx.user.name,
      balanceAfter: balance,
      comment: input.comment,
    });
    const doc = await storeDocument(tx, ctx, { kind: 'PAYMENT_RECEIPT', bytes, fileName: `Kvitansiya-${number}.pdf`, number, shopId: input.shopId, paymentId: pay.id });
    return { pay, balance, unallocated, shopName: shop.name, docId: doc.id };
  });
  const text = `💰 To'lov: <b>${esc(result.shopName)}</b> — ${formatMoney(input.amount)} (${t(`payMethod.${input.method}` as never)})\nQarz: ${formatMoney(Math.max(0, result.balance))}${result.balance < 0 ? `\nAvans: ${formatMoney(-result.balance)}` : ''}`;
  if (!isOwner(ctx.user)) await notifyOwners(ctx, `👤 ${esc(ctx.user.name)}: ${text}`, [[{ text: t('bot.open'), app: `s_${input.shopId}` }]]);
  return { id: result.pay.id, balance: result.balance, credit: result.unallocated, documentId: result.docId };
}

export async function voidPayment(ctx: Ctx, id: number, reason: string) {
  if (!isOwner(ctx.user)) throw forbidden("To'lovni faqat egasi bekor qiladi");
  if (!reason.trim()) throw bad('Sababini yozing');
  await inTx(ctx.db, async (tx) => {
    const p = await tx.payment.findUnique({ where: { id } });
    if (!p) throw notFound();
    if (p.voidedAt) return;
    await tx.payment.update({ where: { id }, data: { voidedAt: ctx.now(), voidReason: reason } });
    await tx.document.updateMany({ where: { paymentId: id }, data: { voidedAt: ctx.now(), voidReason: reason } });
    await reallocateShop(tx, p.shopId);
    await audit(tx, ctx.user.id, 'payment.void', 'payment', id, { amount: p.amount }, { voided: true, reason });
  });
}

// ───────────────────────── Debtors ─────────────────────────

export async function debtors(ctx: Ctx, shopWhere: object) {
  const today = localDate(ctx.now());
  const shops = await ctx.db.shop.findMany({ where: { ...shopWhere, archivedAt: null }, select: { id: true, name: true, phones: true, address: true, agent: { select: { name: true } } } });
  const balances = await shopBalances(ctx.db, today, shops.map((s) => s.id));
  const open = await ctx.db.order.findMany({
    where: { shopId: { in: shops.map((s) => s.id) }, status: 'DELIVERED' },
    select: { shopId: true, total: true, paidAmount: true, returnedAmount: true, deliveredAt: true },
  });
  const buckets = new Map<number, { b0: number; b8: number; b30: number }>();
  for (const o of open) {
    const left = outstanding(o);
    if (left <= 0 || !o.deliveredAt) continue;
    const age = daysBetween(localDate(o.deliveredAt), today);
    const b = buckets.get(o.shopId) ?? { b0: 0, b8: 0, b30: 0 };
    if (age <= 7) b.b0 += left;
    else if (age <= 30) b.b8 += left;
    else b.b30 += left;
    buckets.set(o.shopId, b);
  }
  const lastPay = await ctx.db.payment.groupBy({ by: ['shopId'], where: { shopId: { in: shops.map((s) => s.id) }, voidedAt: null }, _max: { paidAt: true } });
  const lp = new Map(lastPay.map((p) => [p.shopId, p._max.paidAt]));
  const rows = shops
    .map((s) => {
      const b = balances.get(s.id)!;
      return {
        shopId: s.id,
        name: s.name,
        phones: s.phones,
        address: s.address,
        agentName: s.agent?.name ?? null,
        balance: b.balance,
        overdue: b.overdue,
        ageDays: b.oldestUnpaid ? daysBetween(b.oldestUnpaid, today) : 0,
        buckets: buckets.get(s.id) ?? { b0: 0, b8: 0, b30: 0 },
        lastPaymentAt: lp.get(s.id) ?? null,
      };
    })
    .filter((r) => r.balance > 0);
  const totals = rows.reduce(
    (a, r) => ({ total: a.total + r.balance, overdue: a.overdue + r.overdue, b0: a.b0 + r.buckets.b0, b8: a.b8 + r.buckets.b8, b30: a.b30 + r.buckets.b30 }),
    { total: 0, overdue: 0, b0: 0, b8: 0, b30: 0 },
  );
  return { rows, totals };
}

// ───────────────────────── Cash in hands ─────────────────────────

export async function cashInHands(ctx: Ctx) {
  const where = { voidedAt: null, handedOverAt: null, ...(isOwner(ctx.user) ? {} : { receivedById: ctx.user.id }) };
  const pays = await ctx.db.payment.findMany({ where, include: { receivedBy: { select: { id: true, name: true, role: true } }, shop: { select: { name: true } } }, orderBy: { paidAt: 'desc' } });
  const people = new Map<number, { userId: number; name: string; role: string; total: number; byMethod: Record<string, number>; payments: unknown[] }>();
  for (const p of pays) {
    const e = people.get(p.receivedById) ?? { userId: p.receivedById, name: p.receivedBy.name, role: p.receivedBy.role, total: 0, byMethod: {}, payments: [] };
    e.total += p.amount;
    e.byMethod[p.method] = (e.byMethod[p.method] ?? 0) + p.amount;
    e.payments.push({ id: p.id, amount: p.amount, method: p.method, shopName: p.shop.name, paidAt: p.paidAt });
    people.set(p.receivedById, e);
  }
  const handovers = await ctx.db.cashHandover.findMany({
    where: isOwner(ctx.user) ? {} : { fromUserId: ctx.user.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const users = await ctx.db.user.findMany({ select: { id: true, name: true } });
  const name = new Map(users.map((u) => [u.id, u.name]));
  return {
    people: [...people.values()],
    handovers: handovers.map((h) => ({ id: h.id, amount: h.amount, from: name.get(h.fromUserId), confirmedBy: name.get(h.confirmedById), at: h.createdAt, note: h.note })),
  };
}

/** Owner confirms "Topshirildi": the cash this person holds is now with the owner. */
export async function confirmHandover(ctx: Ctx, fromUserId: number, paymentIds?: number[], note?: string) {
  if (!isOwner(ctx.user)) throw forbidden();
  return inTx(ctx.db, async (tx) => {
    const pays = await tx.payment.findMany({
      where: { receivedById: fromUserId, handedOverAt: null, voidedAt: null, ...(paymentIds?.length ? { id: { in: paymentIds } } : {}) },
    });
    if (!pays.length) throw bad("Topshiriladigan pul yo'q");
    const amount = pays.reduce((s, p) => s + p.amount, 0);
    const h = await tx.cashHandover.create({ data: { fromUserId, amount, confirmedById: ctx.user.id, note: note || null } });
    await tx.payment.updateMany({ where: { id: { in: pays.map((p) => p.id) } }, data: { handoverId: h.id, handedOverAt: ctx.now() } });
    await audit(tx, ctx.user.id, 'cash.handover', 'user', fromUserId, undefined, { amount, payments: pays.length, handoverId: h.id });
    return { id: h.id, amount };
  });
}

// ───────────────────────── Returns ─────────────────────────

export interface ReturnInput {
  shopId: number;
  orderId?: number | null;
  date?: string;
  reason?: string | null;
  lines: { productId: number; qtyCans: number; condition: ReturnCondition; pricePerCan?: number }[];
}

/** A return inside the caller's transaction. Sellable cans go back to `where` (warehouse or car). */
export async function createReturnInTx(tx: Tx, ctx: Ctx, input: ReturnInput, where: Place = WAREHOUSE) {
  if (!input.lines.length) throw bad("Kamida bitta mahsulot qo'shing");
  const today = localDate(ctx.now());
  const date = input.date ?? today;
  {
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: input.shopId } });
    const order = input.orderId
      ? await tx.order.findFirst({ where: { id: input.orderId, shopId: input.shopId, status: 'DELIVERED' }, include: { items: true } })
      : null;
    if (input.orderId && !order) throw bad('Faqat yetkazilgan hujjatdan qaytarish mumkin');
    const prices = await pricesForShop(tx, input.shopId, ctx.now());
    const products = new Map((await tx.product.findMany({ where: { id: { in: input.lines.map((l) => l.productId) } } })).map((p) => [p.id, p]));

    const lines = input.lines.map((l) => {
      const p = products.get(l.productId);
      if (!p) throw bad('Mahsulot topilmadi');
      if (!Number.isInteger(l.qtyCans) || l.qtyCans <= 0) throw bad(`${p.flavour}: miqdor noto'g'ri`);
      // Price: what the shop paid on that invoice, otherwise today's price for this shop
      const fromOrder = order?.items.find((i) => i.productId === l.productId && !i.isBonus);
      const owner = isOwner(ctx.user);
      const perCan = owner && l.pricePerCan != null ? l.pricePerCan : (fromOrder?.pricePerCan ?? prices.get(l.productId)?.perCan ?? 0);
      return { ...l, product: p, pricePerCan: perCan, lineTotal: perCan * l.qtyCans };
    });
    if (order) {
      for (const l of lines) {
        const delivered = order.items.filter((i) => i.productId === l.productId).reduce((s, i) => s + i.qtyCans, 0);
        const already = await tx.returnItem.aggregate({ where: { productId: l.productId, return: { orderId: order.id, voidedAt: null } }, _sum: { qtyCans: true } });
        if (l.qtyCans + (already._sum.qtyCans ?? 0) > delivered) throw bad(`${l.product.flavour}: yetkazilganidan ko'p qaytarib bo'lmaydi`);
      }
    }
    const total = lines.reduce((s, l) => s + l.lineTotal, 0);
    const year = Number(date.slice(0, 4));
    const n = await nextNumber(tx, 'RETURN', year);
    const number = formatDocNumber(ctx.settings.returnPrefix, year, n, ctx.settings.numberDigits);
    const ret = await tx.return.create({
      data: {
        number,
        shopId: input.shopId,
        orderId: order?.id ?? null,
        date: date === today ? ctx.now() : localDateTime(date, '12:00'),
        total,
        reason: input.reason || null,
        createdById: ctx.user.id,
        items: { create: lines.map((l) => ({ productId: l.productId, qtyCans: l.qtyCans, pricePerCan: l.pricePerCan, lineTotal: l.lineTotal, condition: l.condition })) },
      },
    });

    // Stock: sellable cans go back into stock as a new batch; damaged/expired to the damaged pool
    for (const l of lines) {
      if (l.condition === 'SELLABLE') {
        const cost = await averageCost(tx, l.productId);
        const batch = await tx.stockBatch.create({ data: { productId: l.productId, landedCostPerCan: cost, receivedCans: l.qtyCans, remainingCans: l.qtyCans, place: where.place, carUserId: where.carUserId ?? null } });
        await movement(tx, { productId: l.productId, batchId: batch.id, type: 'RETURN_IN', qtyCans: l.qtyCans, costPerCan: cost, place: where.place, carUserId: where.carUserId ?? null, returnId: ret.id, shopId: input.shopId, orderId: order?.id, userId: ctx.user.id, reason: input.reason });
      } else {
        await movement(tx, { productId: l.productId, type: 'RETURN_IN', pool: 'DAMAGED', qtyCans: l.qtyCans, returnId: ret.id, shopId: input.shopId, orderId: order?.id, userId: ctx.user.id, reason: `${t(`returnCondition.${l.condition}` as never)}${input.reason ? ': ' + input.reason : ''}` });
      }
    }
    await reallocateShop(tx, input.shopId);
    const balance = (await shopBalances(tx, today, [input.shopId])).get(input.shopId)!.balance;
    const bytes = await returnDocument({
      number,
      date,
      business: await bizInfo(tx, ctx.blobs, ctx.settings),
      shop: shopParty(shop),
      orderNumber: order?.number,
      lines: lines.map((l) => ({ flavour: `${l.product.name} ${l.product.flavour}`, qtyCans: l.qtyCans, packSize: l.product.packSize, pricePerPack: 0, pricePerCan: l.pricePerCan, isBonus: false, lineTotal: l.lineTotal, condition: l.condition })),
      total,
      reason: input.reason,
      newBalance: balance,
    });
    const doc = await storeDocument(tx, ctx, { kind: 'RETURN_ACT', bytes, fileName: `Qaytarish-${number}.pdf`, number, returnId: ret.id, shopId: input.shopId, orderId: order?.id });
    await audit(tx, ctx.user.id, 'return.create', 'return', ret.id, undefined, { number, shopId: input.shopId, total, lines: input.lines });
    return { ret, docId: doc.id, shopName: shop.name, balance };
  }
}

export async function createReturn(ctx: Ctx, input: ReturnInput) {
  const result = await inTx(ctx.db, (tx) => createReturnInTx(tx, ctx, input));
  await sendDocumentToChat(ctx, result.docId, ctx.user.telegramId, `↩️ ${t('docKind.RETURN_ACT')} ${result.ret.number}\n<b>${esc(result.shopName)}</b> · ${formatMoney(result.ret.total)}`);
  if (!isOwner(ctx.user)) await notifyOwners(ctx, `👤 ${esc(ctx.user.name)}: qaytarish ${result.ret.number}, ${esc(result.shopName)} — ${formatMoney(result.ret.total)}`);
  return { id: result.ret.id, number: result.ret.number, total: result.ret.total, balance: result.balance };
}

// ───────────────────────── Reconciliation (akt sverki) ─────────────────────────

export async function reconciliationData(ctx: Ctx, shopId: number, from: string, to: string) {
  const fromAt = startOfLocalDay(from);
  const toAt = startOfLocalDay(addDays(to, 1));
  const [orders, pays, rets] = await Promise.all([
    ctx.db.order.findMany({ where: { shopId, status: 'DELIVERED' }, include: { documents: { where: { kind: 'WAYBILL', voidedAt: null } } } }),
    ctx.db.payment.findMany({ where: { shopId, voidedAt: null } }),
    ctx.db.return.findMany({ where: { shopId, voidedAt: null } }),
  ]);
  let opening = 0;
  const rows: { at: Date; date: string; doc: string; debit: number; credit: number }[] = [];
  for (const o of orders) {
    const at = o.deliveredAt ?? o.createdAt;
    if (at < fromAt) opening += o.total;
    else if (at < toAt) rows.push({ at, date: localDate(at), doc: o.isOpening ? "Boshlang'ich qarz" : `Yuk xati ${o.documents[0]?.number ?? o.number}`, debit: o.total, credit: 0 });
  }
  for (const p of pays) {
    if (p.paidAt < fromAt) opening -= p.amount;
    else if (p.paidAt < toAt) rows.push({ at: p.paidAt, date: localDate(p.paidAt), doc: `To'lov (${t(`payMethod.${p.method}` as never).toLowerCase()})`, debit: 0, credit: p.amount });
  }
  for (const r of rets) {
    if (r.date < fromAt) opening -= r.total;
    else if (r.date < toAt) rows.push({ at: r.date, date: localDate(r.date), doc: `Qaytarish ${r.number}`, debit: 0, credit: r.total });
  }
  rows.sort((a, b) => a.at.getTime() - b.at.getTime());
  const closing = opening + rows.reduce((s, r) => s + r.debit - r.credit, 0);
  return { opening, rows: rows.map(({ at: _at, ...r }) => r), closing };
}

export async function createReconciliation(ctx: Ctx, shopId: number, from: string, to: string) {
  if (from > to) throw bad("Sana oralig'i noto'g'ri");
  const data = await reconciliationData(ctx, shopId, from, to);
  const today = localDate(ctx.now());
  const r = await inTx(ctx.db, async (tx) => {
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
    const year = Number(today.slice(0, 4));
    const n = await nextNumber(tx, 'RECONCILIATION', year);
    const number = formatDocNumber(ctx.settings.reconciliationPrefix, year, n, ctx.settings.numberDigits);
    const bytes = await reconciliationDocument({ number, date: today, from, to, business: await bizInfo(tx, ctx.blobs, ctx.settings), shop: shopParty(shop), ...data });
    const doc = await storeDocument(tx, ctx, {
      kind: 'RECONCILIATION',
      bytes,
      fileName: `Akt-sverki-${number}.pdf`,
      number,
      shopId,
      periodFrom: new Date(from + 'T00:00:00Z'),
      periodTo: new Date(to + 'T00:00:00Z'),
    });
    return { docId: doc.id, number, shopName: shop.name };
  });
  await sendDocumentToChat(ctx, r.docId, ctx.user.telegramId, `📑 ${t('docKind.RECONCILIATION')} ${r.number}\n<b>${esc(r.shopName)}</b> · ${from} — ${to}\nQoldiq: ${formatMoney(data.closing)}`);
  return { documentId: r.docId, number: r.number, ...data };
}
