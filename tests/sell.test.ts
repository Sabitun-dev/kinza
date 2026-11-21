import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop, addStock, areaA } from './helpers/fixtures.ts';

// Monday 23 Nov 2026 — area A's day
const MON = '2026-11-23';
const FRI = '2026-11-27';
const at = (day: string, hhmm = '10:00') => new Date(`${day}T${hhmm}:00+05:00`);

async function world() {
  let clock = at(MON);
  const t = await createTestApp({ now: () => clock });
  const setDay = (d: string) => (clock = at(d));
  const limon = await addProduct(t, 'Limon', 120_000);
  const cola = await addProduct(t, 'Cola', 110_000);
  await addStock(t, limon, 24 * 50, 3875, '2027-05-01');
  await addStock(t, cola, 24 * 50, 3750, '2027-05-01');
  await t.owner.post('/api/car/load', { lines: [{ productId: limon, qtyCans: 24 * 10 }, { productId: cola, qtyCans: 24 * 3 }] });
  const shop = await addShop(t, 'Baraka', { districtId: await areaA(t) });
  return { ...t, setDay, limon, cola, shop };
}
const carOf = async (t: Awaited<ReturnType<typeof world>>, pid: number) => (await t.owner.get('/api/car')).data.products.find((p: any) => p.productId === pid).inCar;
let k = 0;
const key = () => `sell-key-${++k}-${Date.now()}`;

describe('Sotish', () => {
  it('order + delivery from the car + nakladnoy + payment + visit + checklist, in one step', async () => {
    const t = await world();
    await t.owner.post(`/api/shops/${t.shop}/opening-balance`, { amount: 1_200_000, date: MON });
    const before = (await t.owner.get('/api/checklist')).data;
    expect(before.items[0].status).toBe('PENDING');
    const r = await t.owner.post('/api/sell', {
      shopId: t.shop,
      lines: [{ productId: t.limon, qtyCans: 120 }, { productId: t.cola, qtyCans: 30 }],
      payment: { amount: 1_200_000, method: 'CASH' },
      idempotencyKey: key(),
      pos: { lat: 41, lng: 71.6 },
    });
    expect(r.status).toBe(200);
    expect(r.data.number).toBe('KD-2026-0001');
    expect(r.data.total).toBe(600_000 + 110_000 + 6 * Math.round(110_000 / 24));
    expect(r.data.balance).toBe(r.data.total); // old debt paid, new invoice open
    const o = (await t.owner.get(`/api/orders/${r.data.orderId}`)).data.order;
    expect(o.status).toBe('DELIVERED');
    expect(await carOf(t, t.limon)).toBe(240 - 120);
    expect(await carOf(t, t.cola)).toBe(72 - 30);
    expect(await t.db.visit.count({ where: { shopId: t.shop, result: 'ORDERED' } })).toBe(1);
    const after = (await t.owner.get('/api/checklist')).data;
    expect(after.items[0].status).toBe('SOLD');
    expect(t.notifier.sent.some((m) => m.file?.name === 'Nakladnoy-KD-2026-0001.pdf')).toBe(true);
  });

  it('is atomic: more than the car holds saves nothing at all', async () => {
    const t = await world();
    const r = await t.owner.post('/api/sell', {
      shopId: t.shop,
      lines: [{ productId: t.limon, qtyCans: 24 }, { productId: t.cola, qtyCans: 24 * 4 }],
      payment: { amount: 50_000, method: 'CASH' },
      idempotencyKey: key(),
    });
    expect(r.status).toBe(409);
    expect(r.data.error).toContain('Mashinada 3 blok Cola bor');
    expect(await t.db.order.count()).toBe(0);
    expect(await t.db.payment.count()).toBe(0);
    expect(await t.db.visit.count()).toBe(0);
    expect(await carOf(t, t.limon)).toBe(240);
    expect((await t.owner.get('/api/checklist')).data.items[0].status).toBe('PENDING');
    const batches = await t.db.stockBatch.findMany();
    expect(batches.every((b) => b.remainingCans >= 0)).toBe(true);
  });

  it('the same request twice creates one sale', async () => {
    const t = await world();
    const body = { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 24 }], idempotencyKey: key() };
    const a = await t.owner.post('/api/sell', body);
    const b = await t.owner.post('/api/sell', body);
    expect(b.data.duplicate).toBe(true);
    expect(b.data.orderId).toBe(a.data.orderId);
    expect(await t.db.order.count({ where: { status: 'DELIVERED', isOpening: false } })).toBe(1);
    expect(await carOf(t, t.limon)).toBe(216);
  });

  it('returns in the same step: sellable back to the car, damaged to the damaged pool', async () => {
    const t = await world();
    const r = await t.owner.post('/api/sell', {
      shopId: t.shop,
      lines: [{ productId: t.limon, qtyCans: 48 }],
      returns: [{ productId: t.limon, qtyCans: 6, condition: 'DAMAGED' }, { productId: t.cola, qtyCans: 12, condition: 'SELLABLE' }],
      returnReason: 'Ezilgan',
      idempotencyKey: key(),
    });
    expect(r.status).toBe(200);
    expect(r.data.returnTotal).toBe(6 * 5000 + 12 * Math.round(110_000 / 24));
    expect(await carOf(t, t.cola)).toBe(72 + 12);
    const limon = (await t.owner.get('/api/products')).data.products.find((p: any) => p.id === t.limon).stock;
    expect(limon.damaged).toBe(6);
  });

  it('pre-order reserves warehouse stock and appears on Friday; delivering it marks 📦', async () => {
    const t = await world();
    const before = (await t.owner.get('/api/products')).data.products.find((p: any) => p.id === t.limon).stock;
    const r = await t.owner.post('/api/sell/preorder', { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 24 * 5 }], idempotencyKey: key() });
    expect(r.data.deliveryDate).toBe(FRI);
    const s = (await t.owner.get('/api/products')).data.products.find((p: any) => p.id === t.limon).stock;
    expect(s.reserved).toBe(before.reserved + 120);
    expect((await t.owner.get('/api/checklist')).data.items[0].status).toBe('SOLD'); // today's visit counted
    t.setDay(FRI);
    const fri = (await t.owner.get('/api/checklist')).data;
    expect(fri.items).toHaveLength(1);
    expect(fri.items[0].source).toBe('PREORDER');
    expect(fri.items[0].orderId).toBe(r.data.id);
    const form = (await t.owner.get(`/api/sell-form?shopId=${t.shop}&orderId=${r.data.id}`)).data;
    expect(form.preorder.lines[0].qtyCans).toBe(120);
    const d = await t.owner.post('/api/sell', { shopId: t.shop, orderId: r.data.id, lines: form.preorder.lines, idempotencyKey: key() });
    expect(d.status).toBe(200);
    expect(d.data.orderId).toBe(r.data.id);
    expect((await t.owner.get('/api/checklist')).data.items[0].status).toBe('DELIVERED');
    expect((await t.owner.get('/api/products')).data.products.find((p: any) => p.id === t.limon).stock.reserved).toBe(before.reserved);
  });

  it('"Buyurtma yo\'q" from Sotish logs a visit and can still collect money', async () => {
    const t = await world();
    await t.owner.post(`/api/shops/${t.shop}/opening-balance`, { amount: 300_000, date: MON });
    const r = await t.owner.post('/api/sell/no-order', { shopId: t.shop, kind: 'NO_ORDER', reason: "Javon to'la", payment: { amount: 300_000, method: 'CASH' }, idempotencyKey: key() });
    expect(r.data.paidNow).toBe(300_000);
    const c = (await t.owner.get('/api/checklist')).data.items[0];
    expect(c.status).toBe('NO_ORDER');
    expect(c.balance).toBe(0);
  });

  it('an agent cannot sell to a shop with overdue debt; the owner can confirm anyway', async () => {
    const t = await world();
    const agent = await t.addUser(2001, 'AGENT');
    await t.owner.patch(`/api/shops/${t.shop}`, { agentId: agent.id });
    await t.owner.post(`/api/shops/${t.shop}/opening-balance`, { amount: 100_000, date: '2026-10-01' });
    const a = await agent.post('/api/sell', { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 24 }], idempotencyKey: key(), force: true });
    expect(a.status).toBe(409);
    const o = await t.owner.post('/api/sell', { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 24 }], idempotencyKey: key(), force: true });
    expect(o.status).toBe(200);
  });
});
