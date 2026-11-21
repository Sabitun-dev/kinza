import type { createTestApp } from './app.ts';

type T = Awaited<ReturnType<typeof createTestApp>>;

/** Creates a product with a default price. Returns its id. */
export async function addProduct(t: T, flavour: string, perPack = 120_000, buy = 90_000, extra: Record<string, unknown> = {}) {
  const r = await t.owner.post('/api/products', {
    flavour,
    buyPricePerPack: buy,
    minPricePerPack: Math.round(perPack * 0.9),
    price: { perPack },
    ...extra,
  });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  return r.data.id as number;
}

export async function addShop(t: T, name: string, extra: Record<string, unknown> = {}, as = t.owner) {
  const r = await as.post('/api/shops', { name, ...extra });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  return r.data.id as number;
}

/** Puts sellable stock on hand directly (as if received from Tashkent). */
export async function addStock(t: T, productId: number, cans: number, costPerCan = 3875, expiry?: string) {
  const b = await t.db.stockBatch.create({
    data: {
      productId,
      landedCostPerCan: costPerCan,
      receivedCans: cans,
      remainingCans: cans,
      expiry: expiry ? new Date(expiry + 'T00:00:00Z') : null,
    },
  });
  await t.db.stockMovement.create({ data: { productId, batchId: b.id, type: 'SUPPLIER_IN', qtyCans: cans, costPerCan } });
  return b.id;
}
