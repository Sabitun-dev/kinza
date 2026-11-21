import type { Ctx } from '../core/context.ts';
import { shopBalances } from './ledger.ts';
import { addDays, daysBetween, localDate, startOfLocalDay, toDbDate } from '../shared/dates.ts';

/** Owner dashboard for a period [from, to] (local dates, inclusive). */
export async function dashboard(ctx: Ctx, from: string, to: string) {
  const start = startOfLocalDay(from);
  const end = startOfLocalDay(addDays(to, 1));
  const today = localDate(ctx.now());
  const delivered = { status: 'DELIVERED' as const, isOpening: false, deliveredAt: { gte: start, lt: end } };

  const [orders, payments, expenses, newShops, items, allShops] = await Promise.all([
    ctx.db.order.findMany({ where: delivered, select: { id: true, total: true, costTotal: true, deliveredAt: true, shopId: true, agentId: true } }),
    ctx.db.payment.findMany({ where: { voidedAt: null, paidAt: { gte: start, lt: end } }, select: { amount: true, paidAt: true, receivedById: true } }),
    ctx.db.expense.findMany({ where: { voidedAt: null, date: { gte: toDbDate(from), lte: toDbDate(to) } }, include: { category: true } }),
    ctx.db.shop.count({ where: { createdAt: { gte: start, lt: end } } }),
    ctx.db.orderItem.findMany({ where: { order: delivered }, select: { productId: true, qtyCans: true, packSize: true, lineTotal: true, isBonus: true } }),
    ctx.db.shop.findMany({ where: { archivedAt: null }, select: { id: true, name: true } }),
  ]);

  const revenue = orders.reduce((s, o) => s + o.total, 0);
  const cost = orders.reduce((s, o) => s + o.costTotal, 0);
  const collected = payments.reduce((s, p) => s + p.amount, 0);
  const expenseSum = expenses.reduce((s, e) => s + e.amount, 0);
  const packs = items.reduce((s, i) => s + i.qtyCans / i.packSize, 0);
  const bal = await shopBalances(ctx.db, today, allShops.map((s) => s.id));
  let debt = 0;
  let overdue = 0;
  for (const b of bal.values()) {
    if (b.balance > 0) debt += b.balance;
    overdue += b.overdue;
  }

  // Daily series
  const days = Math.min(daysBetween(from, to), 92);
  const series = Array.from({ length: days + 1 }, (_, i) => ({ date: addDays(from, i), revenue: 0, collected: 0 }));
  const idx = new Map(series.map((d, i) => [d.date, i]));
  for (const o of orders) {
    const i = idx.get(localDate(o.deliveredAt!));
    if (i !== undefined) series[i].revenue += o.total;
  }
  for (const p of payments) {
    const i = idx.get(localDate(p.paidAt));
    if (i !== undefined) series[i].collected += p.amount;
  }

  // Rankings
  const shopName = new Map(allShops.map((s) => [s.id, s.name]));
  const byShop = new Map<number, number>();
  for (const o of orders) byShop.set(o.shopId, (byShop.get(o.shopId) ?? 0) + o.total);
  const topShops = [...byShop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, total]) => ({ shopId: id, name: shopName.get(id) ?? '—', total }));

  const products = await ctx.db.product.findMany({ where: { archivedAt: null } });
  const byProduct = new Map<number, { packs: number; revenue: number }>(products.map((p) => [p.id, { packs: 0, revenue: 0 }]));
  for (const i of items) {
    const e = byProduct.get(i.productId) ?? { packs: 0, revenue: 0 };
    e.packs += i.qtyCans / i.packSize;
    e.revenue += i.isBonus ? 0 : i.lineTotal;
    byProduct.set(i.productId, e);
  }
  const pname = new Map(products.map((p) => [p.id, p.flavour]));
  const flavours = [...byProduct.entries()]
    .filter(([id]) => pname.has(id))
    .map(([id, v]) => ({ productId: id, flavour: pname.get(id)!, packs: Math.round(v.packs * 10) / 10, revenue: v.revenue }))
    .sort((a, b) => b.packs - a.packs);

  const agents = await ctx.db.user.findMany({ where: { role: 'AGENT' }, select: { id: true, name: true } });
  const agentRanking = agents
    .map((a) => {
      const mine = orders.filter((o) => o.agentId === a.id);
      return {
        userId: a.id,
        name: a.name,
        revenue: mine.reduce((s, o) => s + o.total, 0),
        orders: mine.length,
        collected: payments.filter((p) => p.receivedById === a.id).reduce((s, p) => s + p.amount, 0),
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  const expenseByCategory = new Map<string, number>();
  for (const e of expenses) expenseByCategory.set(e.category.name, (expenseByCategory.get(e.category.name) ?? 0) + e.amount);

  return {
    from,
    to,
    revenue,
    collected,
    grossProfit: revenue - cost,
    expenses: expenseSum,
    netProfit: revenue - cost - expenseSum,
    packsSold: Math.round(packs * 10) / 10,
    orderCount: orders.length,
    avgOrder: orders.length ? Math.round(revenue / orders.length) : 0,
    newShops,
    debt,
    overdue,
    series,
    topShops,
    topFlavours: flavours.slice(0, 5),
    slowFlavours: [...flavours].reverse().slice(0, 5),
    agentRanking,
    expensesByCategory: [...expenseByCategory.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
  };
}

/** Commission for one person and month: % of collected money or of delivered sales. */
export async function commissionStatement(ctx: Ctx, userId: number, month: string) {
  const from = `${month}-01`;
  const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const start = startOfLocalDay(from);
  const end = startOfLocalDay(next);
  const user = await ctx.db.user.findUniqueOrThrow({ where: { id: userId } });
  const [orders, payments] = await Promise.all([
    ctx.db.order.findMany({
      where: { status: 'DELIVERED', isOpening: false, deliveredAt: { gte: start, lt: end }, OR: [{ agentId: userId }, { shop: { agentId: userId } }] },
      include: { shop: { select: { name: true } } },
      orderBy: { deliveredAt: 'asc' },
    }),
    ctx.db.payment.findMany({ where: { voidedAt: null, receivedById: userId, paidAt: { gte: start, lt: end } }, include: { shop: { select: { name: true } } }, orderBy: { paidAt: 'asc' } }),
  ]);
  const sales = orders.reduce((s, o) => s + o.total, 0);
  const collected = payments.reduce((s, p) => s + p.amount, 0);
  const base = user.commissionMode === 'COLLECTED' ? collected : user.commissionMode === 'DELIVERED' ? sales : 0;
  return {
    user: { id: user.id, name: user.name, mode: user.commissionMode, bp: user.commissionBp },
    month,
    sales,
    collected,
    base,
    commission: Math.round((base * user.commissionBp) / 10_000),
    orders: orders.map((o) => ({ id: o.id, number: o.number, shop: o.shop.name, date: localDate(o.deliveredAt!), total: o.total })),
    payments: payments.map((p) => ({ id: p.id, shop: p.shop.name, date: localDate(p.paidAt), amount: p.amount })),
  };
}
