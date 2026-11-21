import type { Tx } from '../core/db.ts';
import { AppError } from '../core/errors.ts';
import type { MovementType, StockPool, StockPlace } from '../generated/prisma/enums.ts';
import { formatQty } from '../shared/qty.ts';

/** A stock place: the warehouse, or one person's car. */
export interface Place {
  place: StockPlace;
  carUserId?: number | null;
}

export const WAREHOUSE: Place = { place: 'WAREHOUSE', carUserId: null };
export const carOf = (userId: number): Place => ({ place: 'CAR', carUserId: userId });
const placeWhere = (p: Place) => (p.place === 'WAREHOUSE' ? { place: 'WAREHOUSE' as const } : { place: 'CAR' as const, carUserId: p.carUserId ?? null });

export interface Taken {
  batchId: number;
  qtyCans: number;
  costPerCan: number;
  place: StockPlace;
  carUserId: number | null;
}

/**
 * Takes sellable cans from a product's batches: oldest expiry first (batches without expiry last),
 * then oldest batch. `from` limits the places, in order of preference (default: everywhere).
 * costMethod "average" prices every can at the average cost of all stock on hand instead.
 */
export async function takeFifo(
  tx: Tx,
  productId: number,
  qty: number,
  costMethod: 'batch' | 'average',
  from?: Place[],
): Promise<Taken[] | { short: number; have: number }> {
  if (qty <= 0) return [];
  const all = await tx.stockBatch.findMany({
    where: { productId, remainingCans: { gt: 0 }, ...(from ? { OR: from.map(placeWhere) } : {}) },
    orderBy: [{ expiry: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  // Preferred place first, FIFO inside each place
  const rank = (b: { place: StockPlace; carUserId: number | null }) =>
    from ? from.findIndex((p) => p.place === b.place && (p.place === 'WAREHOUSE' || (p.carUserId ?? null) === b.carUserId)) : 0;
  const batches = [...all].sort((a, b) => rank(a) - rank(b));
  const have = batches.reduce((s, b) => s + b.remainingCans, 0);
  if (have < qty) return { short: qty - have, have };
  const avg = have ? batches.reduce((s, b) => s + b.remainingCans * b.landedCostPerCan, 0) / have : 0;
  const taken: Taken[] = [];
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const n = Math.min(left, b.remainingCans);
    // Guarded decrement: never below zero even under parallel requests
    const r = await tx.stockBatch.updateMany({ where: { id: b.id, remainingCans: { gte: n } }, data: { remainingCans: { decrement: n } } });
    if (r.count !== 1) throw new AppError("Ombor o'zgardi, qayta urinib ko'ring", 409, 'stock_changed');
    taken.push({ batchId: b.id, qtyCans: n, costPerCan: costMethod === 'average' ? avg : b.landedCostPerCan, place: b.place, carUserId: b.carUserId });
    left -= n;
  }
  return taken;
}

/** Same as takeFifo but throws a clear Uzbek error when stock is not enough. */
export async function takeFifoOrThrow(tx: Tx, product: { id: number; flavour: string; packSize: number }, qty: number, costMethod: 'batch' | 'average', from?: Place[]) {
  const r = await takeFifo(tx, product.id, qty, costMethod, from);
  if (!Array.isArray(r)) {
    const inCar = from?.length === 1 && from[0].place === 'CAR';
    throw new AppError(
      inCar
        ? `Mashinada ${formatQty(r.have, product.packSize)} ${product.flavour} bor — kerak ${formatQty(qty, product.packSize)}`
        : `Omborda yetarli emas: ${product.flavour} — kerak ${formatQty(qty, product.packSize)}, bor ${formatQty(r.have, product.packSize)}`,
      409,
      'no_stock',
      { productId: product.id, need: qty, have: r.have, place: inCar ? 'CAR' : 'ANY' },
    );
  }
  return r;
}

/** Puts cans back into the batches they came from (delivery revision / cancellation). */
export async function putBack(tx: Tx, taken: { batchId: number; qtyCans: number }[]) {
  for (const t of taken) {
    await tx.stockBatch.update({ where: { id: t.batchId }, data: { remainingCans: { increment: t.qtyCans } } });
  }
}

export async function movement(
  tx: Tx,
  m: {
    productId: number;
    type: MovementType;
    qtyCans: number;
    pool?: StockPool;
    place?: StockPlace;
    carUserId?: number | null;
    batchId?: number | null;
    costPerCan?: number | null;
    orderId?: number;
    returnId?: number;
    supplierOrderId?: number;
    stockCountId?: number;
    transferId?: number;
    shopId?: number | null;
    reason?: string | null;
    userId?: number | null;
  },
) {
  return tx.stockMovement.create({ data: { pool: 'SELLABLE', ...m } });
}

/** Weighted average landed cost per can of what is on hand (used for corrections without a batch). */
export async function averageCost(tx: Tx, productId: number): Promise<number> {
  const batches = await tx.stockBatch.findMany({ where: { productId, remainingCans: { gt: 0 } } });
  const n = batches.reduce((s, b) => s + b.remainingCans, 0);
  if (n) return batches.reduce((s, b) => s + b.remainingCans * b.landedCostPerCan, 0) / n;
  const last = await tx.stockBatch.findFirst({ where: { productId }, orderBy: { createdAt: 'desc' } });
  if (last) return last.landedCostPerCan;
  const p = await tx.product.findUnique({ where: { id: productId } });
  return p ? p.buyPricePerPack / p.packSize : 0;
}

/**
 * Moves cans between the warehouse and a car. Each source batch is split, so the cans keep their
 * expiry and landed cost (FIFO and profit stay correct).
 */
export async function transferStock(
  tx: Tx,
  input: { toCar: boolean; carUserId: number; lines: { productId: number; qtyCans: number }[]; userId: number; note?: string | null },
) {
  const from = input.toCar ? WAREHOUSE : carOf(input.carUserId);
  const to = input.toCar ? carOf(input.carUserId) : WAREHOUSE;
  const lines = input.lines.filter((l) => l.qtyCans > 0);
  const t = await tx.stockTransfer.create({ data: { toCar: input.toCar, carUserId: input.carUserId, createdById: input.userId, note: input.note ?? null, lines } });
  for (const l of lines) {
    const product = await tx.product.findUniqueOrThrow({ where: { id: l.productId } });
    const taken = await takeFifoOrThrow(tx, product, l.qtyCans, 'batch', [from]);
    for (const k of taken) {
      const src = await tx.stockBatch.findUniqueOrThrow({ where: { id: k.batchId } });
      const dst = await tx.stockBatch.create({
        data: { productId: l.productId, supplierOrderId: src.supplierOrderId, expiry: src.expiry, landedCostPerCan: src.landedCostPerCan, receivedCans: k.qtyCans, remainingCans: k.qtyCans, place: to.place, carUserId: to.carUserId ?? null },
      });
      await movement(tx, { productId: l.productId, batchId: src.id, type: 'TRANSFER', qtyCans: -k.qtyCans, costPerCan: src.landedCostPerCan, place: from.place, carUserId: from.carUserId ?? null, transferId: t.id, userId: input.userId, reason: input.toCar ? 'Yuklash' : 'Tushirish' });
      await movement(tx, { productId: l.productId, batchId: dst.id, type: 'TRANSFER', qtyCans: k.qtyCans, costPerCan: src.landedCostPerCan, place: to.place, carUserId: to.carUserId ?? null, transferId: t.id, userId: input.userId, reason: input.toCar ? 'Yuklash' : 'Tushirish' });
    }
  }
  return t;
}
