import type { Ctx } from '../core/context.ts';
import type { DbOrTx } from '../core/db.ts';
import { inTx } from '../core/db.ts';
import { audit } from '../core/audit.ts';
import { bad, forbidden } from '../core/errors.ts';
import { isOwner } from '../core/permissions.ts';
import { stockLevels } from './stockLevels.ts';
import { averageCost, movement, takeFifoOrThrow, WAREHOUSE, type Place } from './stock.ts';
import { fromDbDate, localDate, addDays } from '../shared/dates.ts';

export type AdjustType = 'SAMPLE_OUT' | 'DAMAGE' | 'EXPIRED' | 'WRITE_OFF';

/**
 * Manual stock changes:
 *  SAMPLE_OUT — free sample to a shop / lead (sellable −)
 *  DAMAGE, EXPIRED — moved from sellable to the damaged pool
 *  WRITE_OFF — removed for good (from the damaged pool by default)
 */
export async function adjustStock(ctx: Ctx, input: { productId: number; type: AdjustType; qtyCans: number; shopId?: number | null; reason?: string | null; fromPool?: 'SELLABLE' | 'DAMAGED' }) {
  if (!isOwner(ctx.user) && !(ctx.user.role === 'AGENT' && input.type === 'SAMPLE_OUT')) throw forbidden();
  if (!Number.isInteger(input.qtyCans) || input.qtyCans <= 0) throw bad("Miqdor noto'g'ri");
  if (input.type === 'SAMPLE_OUT' && !input.shopId) throw bad("Namuna qaysi do'konga berilganini tanlang");
  return inTx(ctx.db, async (tx) => {
    const product = await tx.product.findUniqueOrThrow({ where: { id: input.productId } });
    const pool = input.type === 'WRITE_OFF' ? (input.fromPool ?? 'DAMAGED') : 'SELLABLE';
    if (pool === 'SELLABLE') {
      const taken = await takeFifoOrThrow(tx, product, input.qtyCans, ctx.settings.costMethod);
      for (const t of taken) {
        await movement(tx, { productId: product.id, batchId: t.batchId, type: input.type, qtyCans: -t.qtyCans, costPerCan: t.costPerCan, place: t.place, carUserId: t.carUserId, shopId: input.shopId, reason: input.reason, userId: ctx.user.id });
      }
      if (input.type === 'DAMAGE' || input.type === 'EXPIRED') {
        await movement(tx, { productId: product.id, type: input.type, pool: 'DAMAGED', qtyCans: input.qtyCans, shopId: input.shopId, reason: input.reason, userId: ctx.user.id });
      }
    } else {
      const damaged = (await stockLevels(tx, [product.id])).get(product.id)!.damaged;
      if (damaged < input.qtyCans) throw bad(`Shikastlangan zaxirada faqat ${damaged} dona bor`);
      await movement(tx, { productId: product.id, type: 'WRITE_OFF', pool: 'DAMAGED', qtyCans: -input.qtyCans, reason: input.reason, userId: ctx.user.id });
    }
    if (input.type === 'SAMPLE_OUT' && input.shopId) {
      const shop = await tx.shop.findUnique({ where: { id: input.shopId } });
      if (shop?.status === 'LEAD') await tx.shop.update({ where: { id: shop.id }, data: { status: 'SAMPLE' } });
    }
    await audit(tx, ctx.user.id, `stock.${input.type.toLowerCase()}`, 'product', product.id, undefined, input);
    return { ok: true };
  });
}

/**
 * Inventarizatsiya: real counts → differences → correction movements.
 * When stock is added (count is higher), the cost is the current average (or costPerPack if given,
 * e.g. for the very first opening stock).
 */
export async function saveStockCount(
  ctx: Ctx,
  input: { note?: string | null; items: { productId: number; countedCans: number; costPerPack?: number | null; expiry?: string | null }[] },
  where: Place = WAREHOUSE,
) {
  if (!isOwner(ctx.user) && !(where.place === 'CAR' && where.carUserId === ctx.user.id)) throw forbidden();
  return inTx(ctx.db, async (tx) => {
    const products = new Map((await tx.product.findMany({ where: { id: { in: input.items.map((i) => i.productId) } } })).map((p) => [p.id, p]));
    const levels = await placeLevels(tx, [...products.keys()], where);
    const count = await tx.stockCount.create({
      data: {
        place: where.place,
        carUserId: where.carUserId ?? null,
        note: input.note || null,
        createdById: ctx.user.id,
        items: { create: input.items.map((i) => ({ productId: i.productId, expectedCans: levels.get(i.productId) ?? 0, countedCans: i.countedCans })) },
      },
    });
    const diffs: { productId: number; flavour: string; diff: number }[] = [];
    for (const i of input.items) {
      const p = products.get(i.productId);
      if (!p) continue;
      if (i.countedCans < 0) throw bad("Miqdor noto'g'ri");
      const diff = i.countedCans - (levels.get(p.id) ?? 0);
      if (diff === 0) continue;
      diffs.push({ productId: p.id, flavour: p.flavour, diff });
      const label = where.place === 'CAR' ? 'Mashina sanog‘i' : 'Inventarizatsiya';
      const reason = input.note ? `${label}: ${input.note}` : label;
      if (diff < 0) {
        const taken = await takeFifoOrThrow(tx, p, -diff, ctx.settings.costMethod, [where]);
        for (const t of taken) {
          await movement(tx, { productId: p.id, batchId: t.batchId, type: 'COUNT_CORRECTION', qtyCans: -t.qtyCans, costPerCan: t.costPerCan, place: t.place, carUserId: t.carUserId, stockCountId: count.id, reason, userId: ctx.user.id });
        }
      } else {
        const cost = i.costPerPack != null ? i.costPerPack / p.packSize : await averageCost(tx, p.id);
        const batch = await tx.stockBatch.create({
          data: { productId: p.id, landedCostPerCan: cost, receivedCans: diff, remainingCans: diff, place: where.place, carUserId: where.carUserId ?? null, expiry: i.expiry ? new Date(i.expiry + 'T00:00:00Z') : null },
        });
        await movement(tx, { productId: p.id, batchId: batch.id, type: 'COUNT_CORRECTION', qtyCans: diff, costPerCan: cost, place: where.place, carUserId: where.carUserId ?? null, stockCountId: count.id, reason, userId: ctx.user.id });
      }
    }
    await audit(tx, ctx.user.id, 'stock.count', 'stockCount', count.id, undefined, { diffs });
    return { id: count.id, diffs };
  });
}

/** Sellable cans per product in one place. */
export async function placeLevels(db: DbOrTx, productIds: number[], where: Place) {
  const rows = await db.stockBatch.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds }, place: where.place, ...(where.place === 'CAR' ? { carUserId: where.carUserId ?? null } : {}) },
    _sum: { remainingCans: true },
  });
  return new Map(rows.map((r) => [r.productId, r._sum.remainingCans ?? 0]));
}

/** Batches with stock left, with an expiry warning flag. */
export async function batchesReport(ctx: Ctx) {
  const warnUntil = addDays(localDate(ctx.now()), ctx.settings.expiryWarnDays);
  const batches = await ctx.db.stockBatch.findMany({
    where: { remainingCans: { gt: 0 } },
    include: { product: { select: { flavour: true, name: true, packSize: true } }, supplierOrder: { select: { number: true } } },
    orderBy: [{ expiry: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
  });
  return batches.map((b) => {
    const exp = fromDbDate(b.expiry);
    return {
      id: b.id,
      productId: b.productId,
      flavour: b.product.flavour,
      packSize: b.product.packSize,
      remainingCans: b.remainingCans,
      receivedCans: b.receivedCans,
      expiry: exp,
      expiringSoon: !!exp && exp <= warnUntil,
      expired: !!exp && exp < localDate(ctx.now()),
      landedCostPerCan: b.landedCostPerCan,
      supplierOrder: b.supplierOrder?.number ?? null,
      createdAt: b.createdAt,
    };
  });
}
