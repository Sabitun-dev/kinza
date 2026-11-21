import type { DbOrTx } from '../core/db.ts';

export interface Point {
  lat: number;
  lng: number;
  /** Stable key for fixed places ("shop:12", "warehouse", "home"); null for a live GPS position. */
  key: string | null;
}

export interface Matrix {
  dist: number[][]; // metres
  time: number[][]; // seconds
  /** True when road data was not available and straight lines × 1.3 were used ("taxminiy"). */
  approximate: boolean;
  /** How many pairs came from the database cache. */
  cached: number;
  source: 'cache' | 'ors' | 'fallback' | 'mixed';
}

const CACHE_DAYS = 30;
const DETOUR = 1.3; // straight line → road
const FALLBACK_KMH = 30; // average city speed for the fallback

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fallbackPair(a: Point, b: Point) {
  const m = haversineMeters(a, b) * DETOUR;
  return { meters: Math.round(m), seconds: Math.round(m / ((FALLBACK_KMH * 1000) / 3600)) };
}

/**
 * Road distance and time between every pair of points.
 * 1) fixed pairs come from the database cache (≤ 30 days old);
 * 2) if anything is missing, one OpenRouteService matrix call (driving-car) fills it and the cache;
 * 3) if that fails (no key, no internet, limit), straight-line × 1.3 is used and marked approximate.
 */
export async function roadMatrix(db: DbOrTx, points: Point[], opts: { apiKey?: string; http?: typeof fetch; now?: Date } = {}): Promise<Matrix> {
  const n = points.length;
  const dist = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const time = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const have = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (let i = 0; i < n; i++) have[i][i] = true;

  const keys = [...new Set(points.map((p) => p.key).filter((k): k is string => !!k))];
  const since = new Date((opts.now ?? new Date()).getTime() - CACHE_DAYS * 86_400_000);
  const rows = keys.length
    ? await db.roadDistance.findMany({ where: { fromKey: { in: keys }, toKey: { in: keys }, fetchedAt: { gte: since } } })
    : [];
  const cache = new Map(rows.map((r) => [`${r.fromKey}|${r.toKey}`, r]));
  let cached = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j || !points[i].key || !points[j].key) continue;
      const r = cache.get(`${points[i].key}|${points[j].key}`);
      if (r) {
        dist[i][j] = r.meters;
        time[i][j] = r.seconds;
        have[i][j] = true;
        cached++;
      }
    }
  }
  const missing = have.some((row) => row.some((x) => !x));
  if (!missing) return { dist, time, approximate: false, cached, source: 'cache' };

  // One matrix request for all points (ORS allows up to 3 500 pairs on the free plan)
  const http = opts.http ?? (typeof fetch === 'function' ? fetch : undefined);
  if (opts.apiKey && http && n * n <= 3500) {
    try {
      const res = await http('https://api.openrouteservice.org/v2/matrix/driving-car', {
        method: 'POST',
        headers: { authorization: opts.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ locations: points.map((p) => [p.lng, p.lat]), metrics: ['distance', 'duration'], units: 'm' }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`ORS ${res.status}`);
      const json = (await res.json()) as { distances: (number | null)[][]; durations: (number | null)[][] };
      const save: { fromKey: string; toKey: string; meters: number; seconds: number }[] = [];
      let gaps = false;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const d = json.distances?.[i]?.[j];
          const s = json.durations?.[i]?.[j];
          if (d == null || s == null) {
            const f = fallbackPair(points[i], points[j]);
            dist[i][j] = f.meters;
            time[i][j] = f.seconds;
            gaps = true;
            continue;
          }
          dist[i][j] = Math.round(d);
          time[i][j] = Math.round(s);
          if (points[i].key && points[j].key) save.push({ fromKey: points[i].key!, toKey: points[j].key!, meters: Math.round(d), seconds: Math.round(s) });
        }
      }
      for (const r of save) {
        await db.roadDistance.upsert({
          where: { fromKey_toKey: { fromKey: r.fromKey, toKey: r.toKey } },
          create: { ...r, fetchedAt: opts.now ?? new Date() },
          update: { meters: r.meters, seconds: r.seconds, fetchedAt: opts.now ?? new Date() },
        });
      }
      return { dist, time, approximate: gaps, cached, source: cached ? 'mixed' : 'ors' };
    } catch (err) {
      console.error('Routing service failed, using straight lines', (err as Error).message);
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (have[i][j]) continue;
      const f = fallbackPair(points[i], points[j]);
      dist[i][j] = f.meters;
      time[i][j] = f.seconds;
    }
  }
  return { dist, time, approximate: true, cached, source: 'fallback' };
}
