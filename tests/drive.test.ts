import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop, addStock, areaA } from './helpers/fixtures.ts';
import { cleanupGps, drivenMeters } from '../src/routing/drive.ts';

const MON = new Date('2026-11-23T09:00:00+05:00');

async function world() {
  const t = await createTestApp({ now: () => MON });
  await t.owner.put('/api/settings', { warehouseLat: 41.0, warehouseLng: 71.6, fuelPer100Km: 8, fuelPrice: 10_000 });
  const area = await areaA(t);
  const limon = await addProduct(t, 'Limon');
  await addStock(t, limon, 24 * 20);
  const a = await addShop(t, 'Birinchi', { districtId: area, lat: 41.01, lng: 71.6 });
  await addShop(t, 'Ikkinchi', { districtId: area, lat: 41.02, lng: 71.6 });
  const list = (await t.owner.get('/api/checklist')).data;
  return { ...t, limon, a, list };
}

describe('driving mode', () => {
  it('start plans the route from my position and returns everything for offline use', async () => {
    const t = await world();
    const r = await t.owner.post(`/api/checklist/${t.list.id}/drive/start`, { start: { lat: 41.0, lng: 71.6 } });
    expect(r.status).toBe(200);
    expect(r.data.route.stops.map((s: any) => s.name)).toEqual(['Birinchi', 'Ikkinchi']);
    expect(r.data.stops[0]).toHaveProperty('lastOrder');
    expect(r.data.startedAt).toBeTruthy();
  });

  it('driven km from GPS points ignores standing still and bad fixes', () => {
    const pts = [
      { lat: 41.0, lng: 71.6, accuracy: 10 },
      { lat: 41.00005, lng: 71.6, accuracy: 10 }, // 5 m jitter
      { lat: 41.01, lng: 71.6, accuracy: 10 }, // ~1.11 km
      { lat: 41.5, lng: 71.6, accuracy: 500 }, // bad fix
      { lat: 41.02, lng: 71.6, accuracy: 15 }, // ~1.11 km
    ];
    expect(Math.round(drivenMeters(pts) / 10) / 100).toBeCloseTo(2.22, 1);
  });

  it('GPS points give driven km; finishing adds one automatic fuel expense', async () => {
    const t = await world();
    await t.owner.post(`/api/checklist/${t.list.id}/drive/start`, { start: { lat: 41.0, lng: 71.6 } });
    const g = await t.owner.post(`/api/checklist/${t.list.id}/gps`, {
      points: [0, 0.01, 0.02, 0.03, 0.04, 0.05].map((d, k) => ({ lat: 41 + d, lng: 71.6, accuracy: 10, at: new Date(MON.getTime() + k * 60_000).toISOString() })),
    });
    expect(g.data.drivenKm).toBeCloseTo(5.6, 0);
    const f = await t.owner.post(`/api/checklist/${t.list.id}/drive/finish`, {});
    expect(f.data.drivenKm).toBe(g.data.drivenKm);
    expect(f.data.fuel).toBe(Math.round(((g.data.drivenKm * 8) / 100) * 10_000));
    await t.owner.post(`/api/checklist/${t.list.id}/drive/finish`, {});
    const exp = await t.db.expense.findMany({ where: { voidedAt: null } });
    expect(exp).toHaveLength(1);
    expect(exp[0].comment).toContain('Avtomatik');
    expect((await t.owner.get('/api/checklist')).data.drivenKm).toBe(g.data.drivenKm);
  });

  it('GPS points older than 30 days are removed', async () => {
    const t = await world();
    await t.db.gpsPoint.createMany({
      data: [
        { userId: 1, lat: 41, lng: 71, at: new Date(MON.getTime() - 31 * 86_400_000) },
        { userId: 1, lat: 41, lng: 71, at: new Date(MON.getTime() - 2 * 86_400_000) },
      ],
    });
    expect(await cleanupGps(t.db, MON)).toBe(1);
    expect(await t.db.gpsPoint.count()).toBe(1);
  });

  it('only my own checklist', async () => {
    const t = await world();
    const agent = await t.addUser(2001, 'AGENT');
    expect((await agent.post(`/api/checklist/${t.list.id}/drive/start`, {})).status).toBe(404);
  });
});
