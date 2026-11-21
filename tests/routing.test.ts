import { describe, expect, it } from 'vitest';
import { evaluate, exact, fuelCost, nearestNeighbour, solve, twoOpt, type Problem } from '../src/routing/solver.ts';
import { haversineMeters, roadMatrix } from '../src/routing/matrix.ts';
import { createTestApp } from './helpers/app.ts';
import { addShop, areaA } from './helpers/fixtures.ts';

// Small deterministic random generator
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

function randomProblem(n: number, seed: number, withEnd = false): Problem {
  const r = rng(seed);
  const pts = Array.from({ length: n + 2 }, () => ({ lat: 41 + r() * 0.08, lng: 71.6 + r() * 0.1 }));
  const dist = pts.map((a) => pts.map((b) => Math.round(haversineMeters(a, b) * 1.3)));
  const time = dist.map((row) => row.map((d) => Math.round(d / 8.3)));
  return { dist, time, start: 0, end: withEnd ? n + 1 : null, departAt: 9 * 60, stops: Array.from({ length: n }, (_, k) => ({ index: k + 1, service: 10 })) };
}

function bruteForce(p: Problem): number {
  let best = Infinity;
  const perm = (arr: number[], rest: number[]) => {
    if (!rest.length) {
      best = Math.min(best, evaluate(p, arr).cost);
      return;
    }
    rest.forEach((x, i) => perm([...arr, x], [...rest.slice(0, i), ...rest.slice(i + 1)]));
  };
  perm([], p.stops.map((_, k) => k));
  return best;
}

describe('solver', () => {
  it('returns the true optimum on small cases (compared with brute force)', () => {
    for (let n = 2; n <= 8; n++) {
      for (const seed of [1, 7, 42]) {
        for (const withEnd of [false, true]) {
          const p = randomProblem(n, seed * 100 + n, withEnd);
          expect(evaluate(p, solve(p)).cost).toBe(bruteForce(p));
        }
      }
    }
  });

  it('2-opt never makes a route longer', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const p = randomProblem(14, seed);
      const nn = nearestNeighbour(p);
      expect(evaluate(p, twoOpt(p, nn)).meters).toBeLessThanOrEqual(evaluate(p, nn).meters);
    }
  });

  it('larger routes finish within the time limit and beat nearest neighbour', () => {
    const p = randomProblem(30, 5);
    const t0 = Date.now();
    const order = solve(p, 2000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(new Set(order).size).toBe(30);
    expect(evaluate(p, order).meters).toBeLessThanOrEqual(evaluate(p, nearestNeighbour(p)).meters);
  });

  it('respects opening hours and "not before"', () => {
    // A line: start(0) – A(1) – B(2) – C(3), 1 km apart, 2 minutes each
    const d = [0, 1000, 2000, 3000];
    const dist = d.map((a) => d.map((b) => Math.abs(a - b)));
    const time = dist.map((row) => row.map((m) => m * 0.12));
    const base: Problem = { dist, time, start: 0, end: null, departAt: 9 * 60, stops: [1, 2, 3].map((i) => ({ index: i, service: 10 })) };
    expect(exact(base)).toEqual([0, 1, 2]);
    // C closes at 09:10 → must be visited first even though it is farthest
    const closes = { ...base, stops: base.stops.map((s, k) => (k === 2 ? { ...s, latest: 9 * 60 + 10 } : s)) };
    const o1 = solve(closes);
    expect(o1[0]).toBe(2);
    expect(evaluate(closes, o1).lateMinutes).toBe(0);
    // A does not want visits before 10:00 → it goes last
    const notBefore = { ...base, stops: base.stops.map((s, k) => (k === 0 ? { ...s, earliest: 10 * 60 } : s)) };
    const o2 = solve(notBefore);
    expect(o2[o2.length - 1]).toBe(0);
    expect(evaluate(notBefore, o2).arrivals[2]).toBeGreaterThanOrEqual(600);
  });

  it('fuel estimate: km × L/100km × price', () => {
    expect(fuelCost(14, 8, 10_500)).toBe(11_760);
    expect(fuelCost(38, 8, 10_000)).toBe(30_400);
  });
});

describe('road distances', () => {
  const pts = [
    { lat: 41.0, lng: 71.6, key: 'warehouse' },
    { lat: 41.01, lng: 71.61, key: 'shop:1' },
    { lat: 41.02, lng: 71.63, key: 'shop:2' },
  ];
  function fakeOrs() {
    let calls = 0;
    const http = (async () => {
      calls++;
      return new Response(JSON.stringify({ distances: [[0, 1500, 3000], [1500, 0, 1700], [3000, 1700, 0]], durations: [[0, 180, 360], [180, 0, 200], [360, 200, 0]] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { http, calls: () => calls };
  }

  it('uses the routing service once, then the database cache', async () => {
    const t = await createTestApp();
    const ors = fakeOrs();
    const a = await roadMatrix(t.db, pts, { apiKey: 'k', http: ors.http });
    expect(a.source).toBe('ors');
    expect(a.dist[0][2]).toBe(3000);
    expect(a.approximate).toBe(false);
    const b = await roadMatrix(t.db, pts, { apiKey: 'k', http: ors.http });
    expect(b.source).toBe('cache');
    expect(b.dist[1][2]).toBe(1700);
    expect(ors.calls()).toBe(1);
    // Cache older than 30 days is refreshed
    await roadMatrix(t.db, pts, { apiKey: 'k', http: ors.http, now: new Date(Date.now() + 31 * 86_400_000) });
    expect(ors.calls()).toBe(2);
  });

  it('falls back to straight line × 1.3 when the service fails', async () => {
    const t = await createTestApp();
    const failing = (async () => new Response('limit', { status: 429 })) as unknown as typeof fetch;
    const m = await roadMatrix(t.db, pts, { apiKey: 'k', http: failing });
    expect(m.approximate).toBe(true);
    expect(m.dist[0][1]).toBe(Math.round(haversineMeters(pts[0], pts[1]) * 1.3));
    const none = await roadMatrix(t.db, pts, {});
    expect(none.approximate).toBe(true);
  });
});

describe('route on the checklist', () => {
  const MON = new Date('2026-11-23T09:00:00+05:00');

  it('plans, stores the order and the comparison; re-planning covers exactly the remaining stops', async () => {
    const t = await createTestApp({ now: () => MON });
    await t.owner.put('/api/settings', { warehouseLat: 41.0, warehouseLng: 71.6, routeEnd: 'last' });
    const area = await areaA(t);
    // Shops along a line, named in the "wrong" order
    const coords = [0.05, 0.01, 0.04, 0.02, 0.03];
    for (const [k, d] of coords.entries()) await addShop(t, `Do'kon ${k + 1}`, { districtId: area, lat: 41.0 + d, lng: 71.6 });
    const list = (await t.owner.get('/api/checklist')).data;
    const r = await t.owner.post(`/api/checklist/${list.id}/route`, {});
    expect(r.status).toBe(200);
    expect(r.data.approximate).toBe(true); // no ORS key in tests
    expect(r.data.stops.map((s: any) => s.name)).toEqual(["Do'kon 2", "Do'kon 4", "Do'kon 5", "Do'kon 3", "Do'kon 1"]);
    expect(r.data.totalKm).toBeLessThanOrEqual(r.data.naiveKm);
    expect(r.data.savedKm).toBeGreaterThan(0);
    const after = (await t.owner.get('/api/checklist')).data;
    expect(after.plannedKm).toBe(r.data.totalKm);
    expect(after.items[0].shop.name).toBe("Do'kon 2");
    // Mark the first two done, re-plan from a new position
    await t.owner.post(`/api/checklist/items/${after.items[0].id}/closed`, {});
    await t.owner.post(`/api/checklist/items/${after.items[1].id}/no-order`, { reason: "Javon to'la" });
    const re = await t.owner.post(`/api/checklist/${list.id}/route`, { start: { lat: 41.06, lng: 71.6 } });
    expect(re.data.stops.map((s: any) => s.name).sort()).toEqual(["Do'kon 1", "Do'kon 3", "Do'kon 5"]);
    expect(re.data.stops[0].name).toBe("Do'kon 1"); // nearest to the new position
    expect((await t.owner.get('/api/checklist')).data.plannedKm).toBe(r.data.totalKm); // morning plan kept
  });

  it('manual order keeps the dragged stops and can re-optimise the rest', async () => {
    const t = await createTestApp({ now: () => MON });
    await t.owner.put('/api/settings', { warehouseLat: 41.0, warehouseLng: 71.6, routeEnd: 'last' });
    const area = await areaA(t);
    for (const [k, d] of [0.01, 0.02, 0.03, 0.04].entries()) await addShop(t, `S${k + 1}`, { districtId: area, lat: 41.0 + d, lng: 71.6 });
    const list = (await t.owner.get('/api/checklist')).data;
    const ids = Object.fromEntries(list.items.map((i: any) => [i.shop.name, i.id]));
    const m = await t.owner.post(`/api/checklist/${list.id}/route`, { order: [ids.S4, ids.S1, ids.S2, ids.S3] });
    expect(m.data.stops.map((s: any) => s.name)).toEqual(['S4', 'S1', 'S2', 'S3']);
    const re = await t.owner.post(`/api/checklist/${list.id}/route`, { order: [ids.S4, ids.S1, ids.S2, ids.S3], fixedCount: 1 });
    expect(re.data.stops.map((s: any) => s.name)).toEqual(['S4', 'S3', 'S2', 'S1']);
    expect(re.data.totalKm).toBeLessThan(m.data.totalKm);
    // "Keyinroq qaytaman" puts S4 back at its best later place
    const later = await t.owner.post(`/api/checklist/${list.id}/route`, { later: ids.S4 });
    expect(later.data.stops[0].name).not.toBe('S4');
    expect(later.data.stops).toHaveLength(4);
  });
});
