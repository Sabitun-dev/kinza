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

const defaultArea = new WeakMap<object, number>();

/** Area "A" (Monday) for shops created in tests unless they say otherwise. */
export async function areaA(t: T) {
  let id = defaultArea.get(t.db);
  if (!id) {
    id = (await t.db.district.create({ data: { name: 'A', routeDay: 1 } })).id;
    defaultArea.set(t.db, id);
  }
  return id;
}

let pin = 0;
export async function addShop(t: T, name: string, extra: Record<string, unknown> = {}, as = t.owner) {
  pin++;
  const r = await as.post('/api/shops', { name, districtId: await areaA(t), lat: 41.0 + pin / 1000, lng: 71.66 + pin / 1000, ...extra });
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
