import type { App } from '../app.ts';
import { ok } from '../app.ts';
import { isOwner, orderScope, shopScope } from '../../core/permissions.ts';
import { outstanding, shopBalances } from '../../domain/ledger.ts';
import { stockLevels } from '../../domain/stockLevels.ts';
import { buildProposal } from '../../domain/supplier.ts';
import { addDays, fromDbDate, localDate, startOfLocalDay, toDbDate } from '../../shared/dates.ts';

/** The home screen: what matters today, for this person. */
export function todayRoutes(app: App) {
  app.get('/api/today', async (c) => {
    const ctx = c.get('ctx');
    const u = ctx.user;
    const today = localDate(ctx.now());
    const dayStart = startOfLocalDay(today);
    const scope = u.role === 'DRIVER' ? { OR: [{ driverId: u.id }, { driverId: null }] } : orderScope(u);

    const [deliveries, tomorrowCount, dueToday, paymentsToday, deliveredToday, reminders] = await Promise.all([
      ctx.db.order.findMany({
        where: { ...scope, status: { in: ['CONFIRMED', 'IN_TRANSIT', 'DELIVERED'] }, deliveryDate: toDbDate(today) },
        include: { shop: { select: { id: true, name: true, address: true, lat: true, lng: true } }, items: { select: { qtyCans: true, packSize: true } } },
        orderBy: { id: 'asc' },
      }),
      ctx.db.order.count({ where: { ...scope, status: { in: ['CONFIRMED', 'IN_TRANSIT'] }, deliveryDate: toDbDate(addDays(today, 1)) } }),
      ctx.db.order.findMany({ where: { ...scope, status: 'DELIVERED', dueDate: { lte: toDbDate(today) } }, select: { total: true, paidAmount: true, returnedAmount: true, dueDate: true } }),
      ctx.db.payment.aggregate({ where: { voidedAt: null, paidAt: { gte: dayStart }, ...(isOwner(u) ? {} : { receivedById: u.id }) }, _sum: { amount: true } }),
      ctx.db.order.aggregate({ where: { ...scope, status: 'DELIVERED', isOpening: false, deliveredAt: { gte: dayStart } }, _sum: { total: true, costTotal: true }, _count: true }),
      ctx.db.reminder.findMany({
        where: { userId: u.id, doneAt: null, dueDate: { lte: toDbDate(today) }, OR: [{ snoozedTo: null }, { snoozedTo: { lte: toDbDate(today) } }] },
        include: { shop: { select: { id: true, name: true } } },
        take: 10,
      }),
    ]);

    const pending = deliveries.filter((o) => o.status !== 'DELIVERED');
    const toCollectToday = pending.reduce((s, o) => s + o.total, 0) + dueToday.filter((o) => fromDbDate(o.dueDate) === today).reduce((s, o) => s + outstanding(o), 0);

    let debt = null;
    if (u.role !== 'DRIVER') {
      const shops = await ctx.db.shop.findMany({ where: { ...shopScope(u), archivedAt: null }, select: { id: true, name: true } });
      const bal = await shopBalances(ctx.db, today, shops.map((s) => s.id));
      const rows = shops.map((s) => ({ ...s, ...bal.get(s.id)! })).filter((r) => r.balance > 0);
      const overdue = rows.filter((r) => r.overdue > 0).sort((a, b) => b.overdue - a.overdue);
      debt = {
        total: rows.reduce((s, r) => s + r.balance, 0),
        overdue: overdue.reduce((s, r) => s + r.overdue, 0),
        topOverdue: overdue.slice(0, 3).map((r) => ({ shopId: r.id, name: r.name, overdue: r.overdue })),
      };
    }

    let stock = null;
    if (u.role !== 'AGENT') {
      const products = await ctx.db.product.findMany({ where: { archivedAt: null } });
      const levels = await stockLevels(ctx.db, products.map((p) => p.id));
      stock = {
        low: products
          .filter((p) => levels.get(p.id)!.available < ctx.settings.lowStockPacks * p.packSize)
          .map((p) => ({ productId: p.id, flavour: p.flavour, available: levels.get(p.id)!.available, packSize: p.packSize })),
        expiring: await ctx.db.stockBatch.count({ where: { remainingCans: { gt: 0 }, expiry: { lte: toDbDate(addDays(today, ctx.settings.expiryWarnDays)) } } }),
      };
    }

    let tashkent = null;
    if (isOwner(u)) {
      const p = await buildProposal(ctx);
      const orderedToday = await ctx.db.supplierOrder.count({ where: { createdAt: { gte: dayStart }, status: { not: 'CANCELLED' } } });
      tashkent = { packs: p.totals.packs, arrivalDate: p.arrivalDate, orderDay: p.orderDay, cutoff: p.cutoff, orderedToday: orderedToday > 0 };
    }

    const visitsToday = u.role === 'DRIVER' ? 0 : await ctx.db.visit.count({ where: { userId: u.id, visitedAt: { gte: dayStart } } });
    const myOrdersToday = u.role === 'DRIVER' ? null : await ctx.db.order.aggregate({ where: { agentId: u.id, createdAt: { gte: dayStart }, status: { not: 'CANCELLED' }, isOpening: false }, _sum: { total: true }, _count: true });

    return ok(c, {
      date: today,
      deliveries: deliveries.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        shop: o.shop,
        total: o.total,
        packs: Math.round(o.items.reduce((s, i) => s + i.qtyCans / i.packSize, 0) * 10) / 10,
      })),
      tomorrowCount,
      toCollectToday,
      collectedToday: paymentsToday._sum.amount ?? 0,
      revenueToday: deliveredToday._sum.total ?? 0,
      grossProfitToday: (deliveredToday._sum.total ?? 0) - (deliveredToday._sum.costTotal ?? 0),
      debt,
      stock,
      tashkent,
      reminders: reminders.map((r) => ({ id: r.id, note: r.note, shop: r.shop, orderId: r.orderId })),
      visitsToday,
      myOrdersToday: myOrdersToday ? { count: myOrdersToday._count, total: myOrdersToday._sum.total ?? 0 } : null,
    });
  });
}
