import type { Tx } from '../core/db.ts';
import { AppError } from '../core/errors.ts';
import type { MovementType, StockPool } from '../generated/prisma/enums.ts';
import { formatQty } from '../shared/qty.ts';

export interface Taken {
  batchId: number;
  qtyCans: number;
  costPerCan: number;
}

/**
 * Takes sellable cans from a product's batches: oldest expiry first (batches without expiry last),
 * then oldest batch. Returns which batches were used and their cost.
 * costMethod "average" prices every can at the average cost of all stock on hand instead.
 */
export async function takeFifo(tx: Tx, productId: number, qty: number, costMethod: 'batch' | 'average'): Promise<Taken[] | { short: number; have: number }> {
  if (qty <= 0) return [];
  const batches = await tx.stockBatch.findMany({
    where: { productId, remainingCans: { gt: 0 } },
    orderBy: [{ expiry: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  const have = batches.reduce((s, b) => s + b.remainingCans, 0);
  if (have < qty) return { short: qty - have, have };
  const avg = have ? batches.reduce((s, b) => s + b.remainingCans * b.landedCostPerCan, 0) / have : 0;
  const taken: Taken[] = [];
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const n = Math.min(left, b.remainingCans);
    await tx.stockBatch.update({ where: { id: b.id }, data: { remainingCans: { decrement: n } } });
    taken.push({ batchId: b.id, qtyCans: n, costPerCan: costMethod === 'average' ? avg : b.landedCostPerCan });
    left -= n;
  }
  return taken;
}

/** Same as takeFifo but throws a clear Uzbek error when stock is not enough. */
export async function takeFifoOrThrow(tx: Tx, product: { id: number; flavour: string; packSize: number }, qty: number, costMethod: 'batch' | 'average') {
  const r = await takeFifo(tx, product.id, qty, costMethod);
  if (!Array.isArray(r)) {
    throw new AppError(
      `Omborda yetarli emas: ${product.flavour} — kerak ${formatQty(qty, product.packSize)}, bor ${formatQty(r.have, product.packSize)}`,
      409,
      'no_stock',
      { productId: product.id, need: qty, have: r.have },
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
    batchId?: number | null;
    costPerCan?: number | null;
    orderId?: number;
    returnId?: number;
    supplierOrderId?: number;
    stockCountId?: number;
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
