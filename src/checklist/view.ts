import type { DbOrTx } from '../core/db.ts';
import type { Settings } from '../core/settings.ts';
import { fileUrl } from '../core/files.ts';
import { shopBalances } from '../domain/ledger.ts';
import { fromDbDate, startOfLocalDay, localDate } from '../shared/dates.ts';
import type { Checklist } from '../generated/prisma/client.ts';

const SOURCE_RANK: Record<string, number> = { CARRY: 0, PREORDER: 1, MOVED: 2, ROUTE: 3, NEW: 4 };

/** A checklist with shop details, in route order (or a sensible order before routing). */
export async function checklistView(db: DbOrTx, s: Settings, list: Checklist, userId: number) {
  const date = fromDbDate(list.date)!;
  const items = await db.checklistItem.findMany({
    where: { checklistId: list.id },
    include: { shop: { include: { district: true } } },
  });
  const shopIds = items.map((i) => i.shopId);
  const [balances, lastOrders, areas, collected, orders] = await Promise.all([
    shopBalances(db, date, shopIds),
    db.order.groupBy({ by: ['shopId'], where: { shopId: { in: shopIds }, isOpening: false, status: 'DELIVERED' }, _max: { deliveredAt: true } }),
    db.district.findMany({ where: { id: { in: list.areaIds } } }),
    db.payment.aggregate({ where: { voidedAt: null, receivedById: userId, paidAt: { gte: startOfLocalDay(date) } }, _sum: { amount: true } }),
    db.order.findMany({ where: { id: { in: items.map((i) => i.orderId).filter((x): x is number => !!x) } }, select: { id: true, total: true, status: true } }),
  ]);
  const last = new Map(lastOrders.map((l) => [l.shopId, l._max.deliveredAt]));
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const rows = items
    .map((i) => {
      const b = balances.get(i.shopId)!;
      return {
        id: i.id,
        shopId: i.shopId,
        status: i.status,
        source: i.source,
        reason: i.reason,
        carryCount: i.carryCount,
        movedTo: fromDbDate(i.movedTo),
        position: i.position,
        etaMin: i.etaMin,
        legKm: i.legKm,
        orderId: i.orderId,
        order: i.orderId ? orderMap.get(i.orderId) ?? null : null,
        doneAt: i.doneAt,
        shop: {
          id: i.shop.id,
          name: i.shop.name,
          address: i.shop.address,
          phones: i.shop.phones,
          lat: i.shop.lat,
          lng: i.shop.lng,
          notes: i.shop.notes,
          openFrom: i.shop.openFrom,
          openTo: i.shop.openTo,
          notBefore: i.shop.notBefore,
          priority: i.shop.priority,
          area: i.shop.district?.name ?? null,
          photoUrl: fileUrl(i.shop.photoFileId, 7 * 86400),
        },
        balance: b.balance,
        overdue: b.overdue,
        lastOrderAt: last.get(i.shopId) ?? null,
      };
    })
    .sort((a, b) => {
      if (a.position != null && b.position != null) return a.position - b.position;
      if (a.position != null) return -1;
      if (b.position != null) return 1;
      return SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || b.shop.priority - a.shop.priority || a.shop.name.localeCompare(b.shop.name);
    });
  const done = rows.filter((r) => r.status !== 'PENDING').length;
  return {
    id: list.id,
    date,
    closed: !!list.closedAt,
    areas: areas.map((a) => a.name),
    route: list.route,
    plannedKm: list.plannedKm,
    plannedMin: list.plannedMin,
    drivenKm: list.drivenKm,
    startedAt: list.startedAt,
    total: rows.length,
    done,
    pending: rows.length - done,
    collected: collected._sum.amount ?? 0,
    toCollect: rows.reduce((sum, r) => sum + Math.max(0, r.balance), 0),
    isToday: date === localDate(),
    items: rows,
    settings: { fuelPer100Km: s.fuelPer100Km, fuelPrice: s.fuelPrice },
  };
}
