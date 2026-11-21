import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop, addStock, areaA } from './helpers/fixtures.ts';

const MON = new Date('2026-11-23T10:00:00+05:00');

describe('an agent invited later', () => {
  it('has their own checklist and car, sells only to their shops, within the discount limit', async () => {
    const t = await createTestApp({ now: () => MON });
    const area = await areaA(t);
    const agent = await t.addUser(2001, 'AGENT');
    await t.owner.patch(`/api/users/${agent.id}`, { commissionMode: 'DELIVERED', commissionBp: 300 });
    const limon = await addProduct(t, 'Limon', 120_000);
    await addStock(t, limon, 24 * 30);
    const mine = await addShop(t, 'Agentniki', { districtId: area, agentId: agent.id });
    const owners = await addShop(t, 'Egasiniki', { districtId: area });

    // Own checklist: only their shops
    const list = (await agent.get('/api/checklist')).data;
    expect(list.items.map((i: any) => i.shop.name)).toEqual(['Agentniki']);
    expect((await t.owner.get('/api/checklist')).data.items.map((i: any) => i.shop.name)).toEqual(['Egasiniki']);

    // Own car: loading from the shared warehouse
    await agent.post('/api/car/load', { lines: [{ productId: limon, qtyCans: 24 * 5 }] });
    expect((await agent.get('/api/car')).data.products[0].inCar).toBe(120);
    expect((await t.owner.get('/api/car')).data.products[0].inCar).toBe(0);

    // Cannot sell to the owner's shop; discount limit holds
    expect((await agent.post('/api/sell', { shopId: owners, lines: [{ productId: limon, qtyCans: 24 }], idempotencyKey: 'agent-sell-1-xx' })).status).toBe(404);
    const cheap = await agent.post('/api/sell', { shopId: mine, lines: [{ productId: limon, qtyCans: 24, pricePerPack: 100_000 }], idempotencyKey: 'agent-sell-2-xx' });
    expect(cheap.status).toBe(400);
    const ok = await agent.post('/api/sell', { shopId: mine, lines: [{ productId: limon, qtyCans: 48, pricePerPack: 115_000 }], idempotencyKey: 'agent-sell-3-xx' });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.data)).not.toMatch(/cost|profit/i);
    expect((await agent.get('/api/car')).data.products[0].inCar).toBe(72);

    // The owner is told; the agent's dashboard shows sales, visits and commission
    expect(t.notifier.sent.some((m) => m.chatId === 1001 && (m.text ?? m.caption ?? '').includes('Sotildi'))).toBe(true);
    const me = (await agent.get('/api/commission')).data;
    expect(me.sales).toBe(230_000);
    expect(me.visits).toBe(1);
    expect(me.commission).toBe(6_900);
  });
});
