import type { Ctx } from '../core/context.ts';
import type { DbOrTx } from '../core/db.ts';
import { inTx } from '../core/db.ts';
import { audit } from '../core/audit.ts';
import { bad } from '../core/errors.ts';
import { ensureChecklist } from '../checklist/checklist.ts';
import { placeLevels, saveStockCount } from './stockOps.ts';
import { carOf, transferStock, WAREHOUSE } from './stock.ts';
import { localDate } from '../shared/dates.ts';

/** Morning load per flavour: expected sales × factor + pre-orders − already in the car, in whole packs. */
export function proposeLoad(x: { expectedCans: number; preorderCans: number; carCans: number; packSize: number; factor: number }) {
  const need = x.expectedCans * x.factor + x.preorderCans - x.carCans;
  return need <= 0 ? 0 : Math.ceil(need / x.packSize - 1e-9);
}

export async function carStock(db: DbOrTx, userId: number) {
  const products = await db.product.findMany({ where: { archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { flavour: 'asc' }] });
  const ids = products.map((p) => p.id);
  const [car, wh] = await Promise.all([placeLevels(db, ids, carOf(userId)), placeLevels(db, ids, WAREHOUSE)]);
  return products.map((p) => ({ productId: p.id, flavour: p.flavour, name: p.name, packSize: p.packSize, inCar: car.get(p.id) ?? 0, warehouse: wh.get(p.id) ?? 0 }));
}

/**
 * Loading proposal for a day's checklist: for each shop, the average of what it took on its last
 * 4 deliveries (shops that never bought count as 0), × loadFactor; plus that day's pre-orders.
 */
export async function loadingProposal(ctx: Ctx, date = localDate(ctx.now())) {
  const list = await ensureChecklist(ctx.db, ctx.settings, ctx.user, date);
  const items = list ? await ctx.db.checklistItem.findMany({ where: { checklistId: list.id, status: 'PENDING' } }) : [];
  const stock = await carStock(ctx.db, ctx.user.id);
  const expected = new Map<number, number>();
  const pre = new Map<number, number>();
  for (const item of items) {
    if (item.orderId) {
      const lines = await ctx.db.orderItem.findMany({ where: { orderId: item.orderId, order: { status: { in: ['CONFIRMED', 'IN_TRANSIT'] } } } });
      for (const l of lines) pre.set(l.productId, (pre.get(l.productId) ?? 0) + l.qtyCans);
      continue;
    }
    const last = await ctx.db.order.findMany({
      where: { shopId: item.shopId, status: 'DELIVERED', isOpening: false },
      orderBy: { deliveredAt: 'desc' },
      take: 4,
      include: { items: true },
    });
    if (!last.length) continue;
    const sum = new Map<number, number>();
    for (const o of last) for (const l of o.items) sum.set(l.productId, (sum.get(l.productId) ?? 0) + l.qtyCans);
    for (const [pid, cans] of sum) expected.set(pid, (expected.get(pid) ?? 0) + cans / last.length);
  }
  const lines = stock.map((s) => {
    const exp = expected.get(s.productId) ?? 0;
    const preorderCans = pre.get(s.productId) ?? 0;
    const packs = proposeLoad({ expectedCans: exp, preorderCans, carCans: s.inCar, packSize: s.packSize, factor: ctx.settings.loadFactor });
    return { ...s, expectedCans: Math.round(exp), preorderCans, proposedPacks: packs, short: packs * s.packSize > s.warehouse };
  });
  return { date, shops: items.length, factor: ctx.settings.loadFactor, lines, totalPacks: lines.reduce((s, l) => s + l.proposedPacks, 0) };
}

export async function moveCarStock(ctx: Ctx, toCar: boolean, lines: { productId: number; qtyCans: number }[], note?: string | null) {
  if (!lines.some((l) => l.qtyCans > 0)) throw bad("Miqdor kiriting");
  return inTx(ctx.db, async (tx) => {
    const t = await transferStock(tx, { toCar, carUserId: ctx.user.id, lines, userId: ctx.user.id, note });
    await audit(tx, ctx.user.id, toCar ? 'car.load' : 'car.unload', 'stockTransfer', t.id, undefined, { lines });
    return { id: t.id };
  });
}

/** Evening count of what is really left in the car. Differences become corrections. */
export function countCar(ctx: Ctx, items: { productId: number; countedCans: number }[], note?: string | null) {
  return saveStockCount(ctx, { note: note ?? 'Kun yakuni', items }, carOf(ctx.user.id));
}
