import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop, addStock, areaA } from './helpers/fixtures.ts';
import { proposeLoad } from '../src/domain/van.ts';

// Monday 23 Nov 2026 — area A's day in the fixtures
const at = (day: string, hhmm = '09:00') => new Date(`${day}T${hhmm}:00+05:00`);

async function world() {
  let clock = at('2026-11-16');
  const t = await createTestApp({ now: () => clock });
  const setDay = (day: string) => (clock = at(day));
  const limon = await addProduct(t, 'Limon');
  const cola = await addProduct(t, 'Cola');
  return { ...t, setDay, limon, cola };
}
const car = async (t: Awaited<ReturnType<typeof world>>, pid: number) => (await t.owner.get('/api/car')).data.products.find((p: any) => p.productId === pid);

describe('loading proposal (pure)', () => {
  it('expected × 1.2 + pre-orders − car, rounded up to packs', () => {
    expect(proposeLoad({ expectedCans: 240, preorderCans: 48, carCans: 24, packSize: 24, factor: 1.2 })).toBe(13); // 288 + 48 − 24 = 312 = 13 packs
    expect(proposeLoad({ expectedCans: 100, preorderCans: 0, carCans: 0, packSize: 24, factor: 1.2 })).toBe(5); // 120 cans → 5 packs
    expect(proposeLoad({ expectedCans: 50, preorderCans: 0, carCans: 200, packSize: 24, factor: 1.2 })).toBe(0);
  });
});

describe('car stock', () => {
  it('loading splits batches and keeps expiry and cost; unloading works; never negative', async () => {
    const t = await world();
    await addStock(t, t.limon, 240, 3800, '2027-03-01');
    const r = await t.owner.post('/api/car/load', { lines: [{ productId: t.limon, qtyCans: 96 }] });
    expect(r.status).toBe(200);
    expect(await car(t, t.limon)).toMatchObject({ inCar: 96, warehouse: 144 });
    const carBatch = await t.db.stockBatch.findFirstOrThrow({ where: { place: 'CAR' } });
    expect(carBatch.landedCostPerCan).toBe(3800);
    expect(carBatch.expiry?.toISOString().slice(0, 10)).toBe('2027-03-01');
    // Can't unload more than the car has
    const bad = await t.owner.post('/api/car/unload', { lines: [{ productId: t.limon, qtyCans: 100 }] });
    expect(bad.status).toBe(409);
    expect(bad.data.error).toContain('Mashinada 4 blok');
    await t.owner.post('/api/car/unload', { lines: [{ productId: t.limon, qtyCans: 24 }] });
    expect(await car(t, t.limon)).toMatchObject({ inCar: 72, warehouse: 168 });
    // Total stock unchanged
    expect((await t.owner.get('/api/products')).data.products.find((p: any) => p.id === t.limon).stock.inStock).toBe(240);
  });

  it('parallel loads never take more than the warehouse has', async () => {
    const t = await world();
    await addStock(t, t.limon, 48);
    const res = await Promise.all([1, 2, 3].map(() => t.owner.post('/api/car/load', { lines: [{ productId: t.limon, qtyCans: 24 }] })));
    expect(res.filter((r) => r.status === 200).length).toBe(2);
    const batches = await t.db.stockBatch.findMany({ where: { productId: t.limon } });
    expect(batches.every((b) => b.remainingCans >= 0)).toBe(true);
    expect(await car(t, t.limon)).toMatchObject({ inCar: 48, warehouse: 0 });
  });

  it('delivery takes from my car first', async () => {
    const t = await world();
    await addStock(t, t.limon, 240);
    await t.owner.post('/api/car/load', { lines: [{ productId: t.limon, qtyCans: 48 }] });
    const shop = await addShop(t, 'Baraka');
    const o = await t.owner.post('/api/orders', { shopId: shop, lines: [{ productId: t.limon, qtyCans: 24 }], confirm: true });
    await t.owner.post(`/api/orders/${o.data.id}/deliver`, {});
    expect(await car(t, t.limon)).toMatchObject({ inCar: 24, warehouse: 192 });
  });

  it('loading proposal uses the last 4 deliveries of today\'s shops and pre-orders', async () => {
    const t = await world();
    await addStock(t, t.limon, 24 * 100);
    await addStock(t, t.cola, 24 * 100);
    const area = await areaA(t);
    const a = await addShop(t, 'A do‘kon', { districtId: area });
    const b = await addShop(t, 'B do‘kon', { districtId: area });
    // Shop A took 10, 10, 10, 6 packs of Limon → average 9 packs = 216 cans
    for (const packs of [10, 10, 10, 6]) {
      const o = await t.owner.post('/api/orders', { shopId: a, lines: [{ productId: t.limon, qtyCans: packs * 24 }], confirm: true, force: true });
      await t.owner.post(`/api/orders/${o.data.id}/deliver`, {});
    }
    // Shop B has a pre-order for Monday: 5 packs Cola
    t.setDay('2026-11-23');
    await t.owner.post('/api/orders', { shopId: b, lines: [{ productId: t.cola, qtyCans: 120 }], confirm: true, force: true, deliveryDate: '2026-11-23' });
    await t.owner.post('/api/car/load', { lines: [{ productId: t.limon, qtyCans: 24 }] });
    const p = (await t.owner.get('/api/car/proposal')).data;
    expect(p.shops).toBe(2);
    const limon = p.lines.find((l: any) => l.productId === t.limon);
    expect(limon.expectedCans).toBe(216);
    expect(limon.proposedPacks).toBe(Math.ceil((216 * 1.2 - 24) / 24)); // 10
    const cola = p.lines.find((l: any) => l.productId === t.cola);
    expect(cola.preorderCans).toBe(120);
    expect(cola.proposedPacks).toBe(5);
  });

  it('evening car count shows and books the difference', async () => {
    const t = await world();
    await addStock(t, t.limon, 240);
    await t.owner.post('/api/car/load', { lines: [{ productId: t.limon, qtyCans: 120 }] });
    const r = await t.owner.post('/api/car/count', { items: [{ productId: t.limon, countedCans: 114 }] });
    expect(r.data.diffs).toEqual([{ productId: t.limon, flavour: 'Limon', diff: -6 }]);
    expect(await car(t, t.limon)).toMatchObject({ inCar: 114, warehouse: 120 });
  });
});
