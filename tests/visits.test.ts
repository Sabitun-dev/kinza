import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop, addStock, areaA } from './helpers/fixtures.ts';

const MON = new Date('2026-11-23T10:00:00+05:00');

describe('visits and leads', () => {
  it('a visit in 3 taps: result, note, follow-up date → reminder; marks today\'s row', async () => {
    const t = await createTestApp({ now: () => MON });
    const shop = await addShop(t, 'Lead do‘kon', { districtId: await areaA(t) });
    await t.owner.get('/api/checklist');
    const key = 'visit-key-123456';
    const r = await t.owner.post('/api/visits', { shopId: shop, result: 'THINKING', note: 'Narxni so‘radi', followUpDate: '2026-11-30', lat: 41, lng: 71.6, idempotencyKey: key });
    expect(r.status).toBe(200);
    expect((await t.owner.post('/api/visits', { shopId: shop, result: 'THINKING', idempotencyKey: key })).data.duplicate).toBe(true);
    const rem = await t.db.reminder.findFirstOrThrow({ where: { shopId: shop } });
    expect(rem.dueDate.toISOString().slice(0, 10)).toBe('2026-11-30');
    expect(rem.note).toContain('Narxni');
    const item = (await t.owner.get('/api/checklist')).data.items[0];
    expect(item.status).toBe('NO_ORDER');
    const list = (await t.owner.get('/api/visits')).data.visits;
    expect(list).toHaveLength(1);
    expect(list[0].lat).toBe(41);
  });

  it('leads pipeline with conversion rates', async () => {
    const t = await createTestApp({ now: () => MON });
    for (const [n, st] of [['L1', 'LEAD'], ['L2', 'LEAD'], ['S1', 'SAMPLE'], ['O1', 'ORDERED'], ['R1', 'REGULAR']] as const) await addShop(t, n, { status: st });
    const r = (await t.owner.get('/api/leads')).data;
    expect(r.columns.map((c: any) => c.shops.length)).toEqual([2, 1, 1, 1]);
    // reached: lead stage 5, sample 3, ordered 2, regular 1
    expect(r.conversion.map((c: any) => c.percent)).toEqual([60, 67, 50]);
  });
});

describe('permissions sweep', () => {
  it('an agent never receives a cost, profit or buying-price field from any screen', async () => {
    const t = await createTestApp({ now: () => MON });
    const agent = await t.addUser(2001, 'AGENT');
    const limon = await addProduct(t, 'Limon');
    await addStock(t, limon, 24 * 20);
    const shop = await addShop(t, 'Agent do‘koni', { agentId: agent.id, districtId: await areaA(t) });
    const o = await t.owner.post('/api/orders', { shopId: shop, lines: [{ productId: limon, qtyCans: 48 }], confirm: true });
    await t.owner.post(`/api/orders/${o.data.id}/deliver`, {});
    const paths = [
      '/api/me',
      '/api/products',
      `/api/products/${limon}`,
      '/api/shops',
      `/api/shops/${shop}`,
      '/api/orders',
      `/api/orders/${o.data.id}`,
      `/api/order-form?shopId=${shop}`,
      `/api/sell-form?shopId=${shop}`,
      '/api/pricing',
      '/api/today',
      '/api/checklist',
      '/api/car',
      '/api/car/proposal',
      '/api/debtors',
      '/api/payments',
      '/api/returns',
      '/api/visits',
      '/api/leads',
      '/api/commission',
      '/api/coverage',
    ];
    for (const p of paths) {
      const r = await agent.get(p);
      expect(r.status, p).toBeLessThan(500);
      expect(JSON.stringify(r.data), p).not.toMatch(/"(buyPricePerPack|costPerCan|costTotal|landedCostPerCan|grossProfit\w*|netProfit|profit|expectedProfit|expectedCost|stockValue|invoiceAmount)"/);
    }
    // Owner-only screens are refused
    for (const p of ['/api/dashboard', '/api/expenses', '/api/supplier/proposal', '/api/supplier-orders', '/api/stock/batches', '/api/settings', '/api/users']) {
      expect((await agent.get(p)).status, p).toBe(403);
    }
  });
});
