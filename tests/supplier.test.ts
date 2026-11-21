import { describe, expect, it } from 'vitest';
import { proposePacks, landedPerPack } from '../src/domain/supplier.ts';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop, addStock } from './helpers/fixtures.ts';

describe('Tashkent proposal (pure)', () => {
  it('orders 50, available 12, safety 5, minimum 10 → 43 packs', () => {
    expect(proposePacks({ ordersPacks: 50, availablePacks: 12, safetyPacks: 5, minPacks: 10 })).toBe(43);
  });
  it('rounds up to whole packs and to the supplier minimum', () => {
    expect(proposePacks({ ordersPacks: 3.25, availablePacks: 0, safetyPacks: 0, minPacks: 0 })).toBe(4);
    expect(proposePacks({ ordersPacks: 6, availablePacks: 2, safetyPacks: 1, minPacks: 10 })).toBe(10);
    expect(proposePacks({ ordersPacks: 5, availablePacks: 30, safetyPacks: 5, minPacks: 10 })).toBe(0);
  });
  it('landed cost: 90 000 + 600 000 cargo over 200 packs = 93 000', () => {
    expect(landedPerPack(90_000, 600_000, 200)).toBe(93_000);
  });
});

describe('supplier flow', () => {
  it('the proposal matches the hand calculation', async () => {
    const t = await createTestApp();
    const limon = await addProduct(t, 'Limon', 120_000, 90_000);
    const shop = await addShop(t, 'Baraka');
    await addStock(t, limon, 12 * 24);
    await t.owner.post('/api/orders', { shopId: shop, lines: [{ productId: limon, qtyCans: 50 * 24 }], confirm: true, deliveryDate: new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10) });
    const p = await t.owner.get('/api/supplier/proposal?coverUntil=2099-01-01');
    const line = p.data.lines.find((l: any) => l.productId === limon);
    expect(line.ordersPacks).toBe(50);
    expect(line.inStockPacks).toBe(12);
    expect(line.proposedPacks).toBe(43);
    expect(line.expectedCost).toBe(43 * 90_000);
    expect(line.expectedRevenue).toBe(43 * 120_000);
    expect(line.expectedProfit).toBe(43 * 30_000);
  });

  it('receiving with differences updates stock, landed cost and supplier balance', async () => {
    const t = await createTestApp();
    const limon = await addProduct(t, 'Limon', 120_000, 90_000);
    const cola = await addProduct(t, 'Cola', 115_000, 90_000);
    const so = await t.owner.post('/api/supplier-orders', {
      lines: [
        { productId: limon, orderedPacks: 120 },
        { productId: cola, orderedPacks: 80 },
      ],
    });
    expect(so.data.number).toBe('T-2026-001');
    await t.owner.post(`/api/supplier-orders/${so.data.id}/status`, { status: 'ORDERED' });
    await t.owner.post(`/api/supplier-orders/${so.data.id}/send`, { format: 'text' });
    expect(t.notifier.sent.at(-1)!.text).toContain('120 blok');
    const detail = (await t.owner.get(`/api/supplier-orders/${so.data.id}`)).data.order;
    const li = detail.items.find((i: any) => i.productId === limon);
    const ci = detail.items.find((i: any) => i.productId === cola);
    // Limon: 118 packs good + 2 damaged; Cola: 80 packs, expiry set
    const r = await t.owner.post(`/api/supplier-orders/${so.data.id}/receive`, {
      cargoCost: 600_000,
      lines: [
        { itemId: li.id, receivedCans: 118 * 24, damagedCans: 2 * 24, expiry: '2027-05-01' },
        { itemId: ci.id, receivedCans: 80 * 24, expiry: '2027-03-01' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.data.differences).toEqual([]);
    const batches = await t.db.stockBatch.findMany({ where: { productId: limon } });
    expect(batches[0].remainingCans).toBe(118 * 24);
    expect(batches[0].landedCostPerCan * 24).toBeCloseTo(93_000, 6);
    const stock = (await t.owner.get('/api/products')).data.products.find((p: any) => p.id === limon).stock;
    expect(stock.inStock).toBe(118 * 24);
    expect(stock.damaged).toBe(48);
    const bal = await t.owner.get('/api/supplier/balance');
    expect(bal.data.balance).toBe(200 * 90_000);
    await t.owner.post('/api/supplier-payments', { amount: 10_000_000, method: 'TRANSFER' });
    expect((await t.owner.get('/api/supplier/balance')).data.balance).toBe(8_000_000);
    // Received twice is refused
    expect((await t.owner.post(`/api/supplier-orders/${so.data.id}/receive`, { lines: [] })).status).toBe(400);
  });

  it('receiving less than ordered is reported as a difference', async () => {
    const t = await createTestApp();
    const limon = await addProduct(t, 'Limon');
    const so = await t.owner.post('/api/supplier-orders', { lines: [{ productId: limon, orderedPacks: 50 }] });
    const item = (await t.owner.get(`/api/supplier-orders/${so.data.id}`)).data.order.items[0];
    const r = await t.owner.post(`/api/supplier-orders/${so.data.id}/receive`, { lines: [{ itemId: item.id, receivedCans: 45 * 24 }] });
    expect(r.data.differences).toEqual([{ flavour: 'Limon', orderedCans: 1200, arrivedCans: 1080 }]);
    expect((await t.owner.get('/api/products')).data.products[0].stock.inStock).toBe(1080);
  });

  it('a driver can receive stock but never sees prices or costs', async () => {
    const t = await createTestApp();
    const limon = await addProduct(t, 'Limon');
    const driver = await t.addUser(3001, 'DRIVER');
    const so = await t.owner.post('/api/supplier-orders', { lines: [{ productId: limon, orderedPacks: 10 }] });
    const d = await driver.get(`/api/supplier-orders/${so.data.id}`);
    expect(JSON.stringify(d.data)).not.toMatch(/buyPricePerPack|invoiceAmount|"cost"|landedPerPack/);
    const r = await driver.post(`/api/supplier-orders/${so.data.id}/receive`, { lines: [{ itemId: d.data.order.items[0].id, receivedCans: 240, buyPricePerPack: 1 }], cargoCost: 999 });
    expect(r.status).toBe(200);
    const b = await t.db.stockBatch.findFirstOrThrow({ where: { productId: limon } });
    expect(b.landedCostPerCan * 24).toBe(90_000); // driver cannot change price or cargo
    expect((await driver.get('/api/supplier/proposal')).status).toBe(403);
  });
});

describe('stock operations', () => {
  it('stock count creates correction movements both ways', async () => {
    const t = await createTestApp();
    const limon = await addProduct(t, 'Limon');
    const cola = await addProduct(t, 'Cola');
    await addStock(t, limon, 100, 3800);
    const r = await t.owner.post('/api/stock-counts', {
      note: 'Oy oxiri',
      items: [
        { productId: limon, countedCans: 94 },
        { productId: cola, countedCans: 48, costPerPack: 90_000 },
      ],
    });
    expect(r.data.diffs).toEqual([
      { productId: limon, flavour: 'Limon', diff: -6 },
      { productId: cola, flavour: 'Cola', diff: 48 },
    ]);
    const products = (await t.owner.get('/api/products')).data.products;
    expect(products.find((p: any) => p.id === limon).stock.inStock).toBe(94);
    expect(products.find((p: any) => p.id === cola).stock.inStock).toBe(48);
    expect(await t.db.stockMovement.count({ where: { type: 'COUNT_CORRECTION' } })).toBe(2);
  });

  it('samples, damage and write-off', async () => {
    const t = await createTestApp();
    const limon = await addProduct(t, 'Limon');
    const lead = await addShop(t, 'Yangi lead');
    await addStock(t, limon, 100);
    await t.owner.post('/api/stock/adjust', { productId: limon, type: 'SAMPLE_OUT', qtyCans: 6, shopId: lead });
    await t.owner.post('/api/stock/adjust', { productId: limon, type: 'DAMAGE', qtyCans: 4, reason: 'tushib ketdi' });
    await t.owner.post('/api/stock/adjust', { productId: limon, type: 'WRITE_OFF', qtyCans: 3 });
    const s = (await t.owner.get('/api/products')).data.products[0].stock;
    expect(s.inStock).toBe(90);
    expect(s.damaged).toBe(1);
    expect((await t.owner.get(`/api/shops/${lead}`)).data.shop.status).toBe('SAMPLE');
  });
});
