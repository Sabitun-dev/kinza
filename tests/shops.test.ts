import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.ts';
import { addShop } from './helpers/fixtures.ts';

describe('shops', () => {
  it('agent sees only their shops and the leads they create', async () => {
    const t = await createTestApp();
    const agent = await t.addUser(2001, 'AGENT');
    const other = await t.addUser(2002, 'AGENT');
    const mine = await addShop(t, 'Mening', { agentId: agent.id });
    await addShop(t, 'Boshqa', { agentId: other.id });
    await addShop(t, 'Egasiniki');
    const lead = await addShop(t, 'Yangi lead', {}, agent);

    const list = (await agent.get('/api/shops')).data.shops.map((s: any) => s.name).sort();
    expect(list).toEqual(['Mening', 'Yangi lead']);
    expect((await agent.get(`/api/shops/${mine}`)).status).toBe(200);
    expect((await agent.get(`/api/shops/${lead}`)).data.shop.agentId).toBe(agent.id);
    const foreign = (await t.owner.get('/api/shops')).data.shops.find((s: any) => s.name === 'Boshqa').id;
    expect((await agent.get(`/api/shops/${foreign}`)).status).toBe(404);
    expect((await agent.patch(`/api/shops/${foreign}`, { name: 'x' })).status).toBe(404);
    expect((await t.owner.get('/api/shops')).data.shops.length).toBe(4);
  });

  it('agent cannot change credit limit, price group or owner', async () => {
    const t = await createTestApp();
    const agent = await t.addUser(2001, 'AGENT');
    const id = await addShop(t, 'Do‘kon', { agentId: agent.id, creditLimit: 1_000_000 });
    await agent.patch(`/api/shops/${id}`, { creditLimit: 99_000_000, agentId: null, notes: 'Yangi izoh' });
    const s = (await t.owner.get(`/api/shops/${id}`)).data.shop;
    expect(s.creditLimit).toBe(1_000_000);
    expect(s.agentId).toBe(agent.id);
    expect(s.notes).toBe('Yangi izoh');
  });

  it('nearby shops come first', async () => {
    const t = await createTestApp();
    await addShop(t, 'Uzoq', { lat: 41.1, lng: 71.8 });
    await addShop(t, 'Yaqin', { lat: 41.0, lng: 71.67 });
    await addShop(t, 'GPS yo‘q');
    const r = await t.owner.get('/api/shops?lat=41.0001&lng=71.6701');
    expect(r.data.shops.map((s: any) => s.name)).toEqual(['Yaqin', 'Uzoq', 'GPS yo‘q']);
    expect(r.data.shops[0].distanceKm).toBeLessThan(0.1);
  });

  it('opening balance becomes debt', async () => {
    const t = await createTestApp();
    const id = await addShop(t, 'Qarzdor');
    const r = await t.owner.post(`/api/shops/${id}/opening-balance`, { amount: 1_500_000, date: '2026-11-01' });
    expect(r.status).toBe(200);
    const s = (await t.owner.get(`/api/shops/${id}`)).data;
    expect(s.balance.balance).toBe(1_500_000);
    expect(s.orders[0].isOpening).toBe(true);
    expect(s.orders[0].number).toMatch(/^QOLDIQ-2026-0001$/);
    expect(await t.db.auditLog.count({ where: { action: 'shop.openingBalance' } })).toBe(1);
  });
});
