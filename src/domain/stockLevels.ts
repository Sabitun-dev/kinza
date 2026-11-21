import type { DbOrTx } from '../core/db.ts';

export interface StockLevel {
  productId: number;
  inStock: number; // sellable cans on hand (warehouse + cars)
  warehouse: number;
  car: number; // all cars together
  damaged: number;
  reserved: number; // in confirmed / on-the-way orders
  available: number; // inStock − reserved (negative = must be ordered)
  nearestExpiry: string | null;
  stockValue: number; // landed cost of what is on hand (owner only)
}

/** Stock per product, in cans. */
export async function stockLevels(db: DbOrTx, productIds?: number[]): Promise<Map<number, StockLevel>> {
  const whereProduct = productIds ? { productId: { in: productIds } } : {};
  const [batches, damaged, reserved] = await Promise.all([
    db.stockBatch.findMany({
      where: { ...whereProduct, remainingCans: { gt: 0 } },
      select: { productId: true, remainingCans: true, expiry: true, landedCostPerCan: true, place: true },
    }),
    db.stockMovement.groupBy({ by: ['productId'], where: { ...whereProduct, pool: 'DAMAGED' }, _sum: { qtyCans: true } }),
    db.orderItem.groupBy({
      by: ['productId'],
      where: { ...whereProduct, order: { status: { in: ['CONFIRMED', 'IN_TRANSIT'] } } },
      _sum: { qtyCans: true },
    }),
  ]);
  const out = new Map<number, StockLevel>();
  const get = (id: number) => {
    let l = out.get(id);
    if (!l) {
      l = { productId: id, inStock: 0, warehouse: 0, car: 0, damaged: 0, reserved: 0, available: 0, nearestExpiry: null, stockValue: 0 };
      out.set(id, l);
    }
    return l;
  };
  for (const b of batches) {
    const l = get(b.productId);
    l.inStock += b.remainingCans;
    if (b.place === 'CAR') l.car += b.remainingCans;
    else l.warehouse += b.remainingCans;
    l.stockValue += b.remainingCans * b.landedCostPerCan;
    const exp = b.expiry?.toISOString().slice(0, 10) ?? null;
    if (exp && (!l.nearestExpiry || exp < l.nearestExpiry)) l.nearestExpiry = exp;
  }
  for (const d of damaged) get(d.productId).damaged = d._sum.qtyCans ?? 0;
  for (const r of reserved) get(r.productId).reserved = r._sum.qtyCans ?? 0;
  for (const l of out.values()) {
    l.available = l.inStock - l.reserved;
    l.stockValue = Math.round(l.stockValue);
  }
  if (productIds) for (const id of productIds) get(id);
  return out;
}
