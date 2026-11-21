import type { Ctx } from '../core/context.ts';
import { inTx } from '../core/db.ts';
import { bad, notFound } from '../core/errors.ts';
import { fromDbDate, localDate, localParts } from '../shared/dates.ts';
import { roadMatrix, type Point } from './matrix.ts';
import { bestInsertion, evaluate, fuelCost, hhmmToMin, solve, solveWithPriority, type Problem, type Stop } from './solver.ts';

export interface RouteStop {
  itemId: number;
  shopId: number;
  name: string;
  lat: number;
  lng: number;
  etaMin: number;
  legKm: number;
}

export interface StoredRoute {
  stops: RouteStop[];
  totalKm: number;
  totalMin: number;
  naiveKm: number;
  savedKm: number;
  fuelSaved: number;
  fuelCost: number;
  approximate: boolean;
  priorityFirst: boolean;
  start: { lat: number; lng: number; label: string } | null;
  end: { lat: number; lng: number; label: string } | null;
  path: [number, number][];
  computedAt: string;
}

const SOURCE_RANK: Record<string, number> = { CARRY: 0, PREORDER: 1, MOVED: 2, ROUTE: 3, NEW: 4 };

interface PlanOptions {
  /** My current GPS position (fallback: the warehouse from settings). */
  start?: { lat: number; lng: number } | null;
  /** Manual order of pending item ids (dragged in the app). */
  order?: number[];
  /** Keep this many stops of `order` as they are and optimise the rest. */
  fixedCount?: number;
  /** Re-insert this item at the best later position ("Keyinroq qaytaman"). */
  later?: number;
}

/** Plans (or re-plans) the route over the shops still ⏳ on a checklist and stores it. */
export async function planRoute(ctx: Ctx, checklistId: number, opts: PlanOptions = {}): Promise<StoredRoute> {
  const list = await ctx.db.checklist.findUnique({ where: { id: checklistId } });
  if (!list || (list.userId !== ctx.user.id && ctx.user.role !== 'OWNER')) throw notFound();
  const s = ctx.settings;
  const items = (await ctx.db.checklistItem.findMany({ where: { checklistId, status: 'PENDING' }, include: { shop: true } })).filter((i) => i.shop.lat != null && i.shop.lng != null);
  if (!items.length) throw bad("Marshrut uchun do'kon qolmadi");

  // The order shown before optimisation (for the "Oddiy tartibda" comparison)
  items.sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || b.shop.priority - a.shop.priority || a.shop.name.localeCompare(b.shop.name));

  const warehouse = s.warehouseLat != null && s.warehouseLng != null ? { lat: s.warehouseLat, lng: s.warehouseLng } : null;
  const home = s.homeLat != null && s.homeLng != null ? { lat: s.homeLat, lng: s.homeLng } : null;
  const startPos = opts.start ?? warehouse;
  const endPos = s.routeEnd === 'warehouse' ? warehouse : s.routeEnd === 'home' ? home : null;

  const points: Point[] = [];
  let startIdx: number | null = null;
  if (startPos) {
    startIdx = points.length;
    points.push({ ...startPos, key: opts.start ? null : 'warehouse' });
  }
  const stopBase = points.length;
  for (const i of items) points.push({ lat: i.shop.lat!, lng: i.shop.lng!, key: `shop:${i.shopId}` });
  let endIdx: number | null = null;
  if (endPos) {
    endIdx = points.length;
    points.push({ ...endPos, key: s.routeEnd });
  }
  const m = await roadMatrix(ctx.db, points, { apiKey: process.env.ORS_API_KEY, http: ctx.http, now: ctx.now() });

  const today = localDate(ctx.now());
  const p = localParts(ctx.now());
  const departAt = fromDbDate(list.date) === today ? p.hour * 60 + p.minute : 9 * 60;
  const stops: Stop[] = items.map((i, k) => {
    const open = hhmmToMin(i.shop.openFrom);
    const notBefore = hhmmToMin(i.shop.notBefore);
    return {
      index: stopBase + k,
      earliest: open != null || notBefore != null ? Math.max(open ?? 0, notBefore ?? 0) : null,
      latest: hhmmToMin(i.shop.openTo),
      service: s.defaultStopMinutes,
    };
  });
  // Without a start point the day starts at the first stop
  const problem: Problem = { dist: m.dist, time: m.time, start: startIdx ?? stopBase, end: endIdx, stops, departAt };

  const naive = items.map((_, k) => k);
  let order: number[];
  let priorityFirst = false;
  if (opts.order?.length) {
    const pos = new Map(items.map((it, k) => [it.id, k]));
    const manual = opts.order.map((id) => pos.get(id)).filter((k): k is number => k !== undefined);
    const missing = naive.filter((k) => !manual.includes(k));
    order = [...manual, ...missing];
    if (opts.fixedCount != null && opts.fixedCount < order.length) {
      const fixed = order.slice(0, opts.fixedCount);
      const rest = order.slice(opts.fixedCount);
      const lastIdx = fixed.length ? stops[fixed[fixed.length - 1]].index : problem.start;
      const before = fixed.length ? evaluate(problem, fixed).minutes : 0;
      const sub = solve({ ...problem, start: lastIdx, departAt: departAt + before, stops: rest.map((k) => stops[k]) });
      order = [...fixed, ...sub.map((i) => rest[i])];
    }
  } else if (opts.later != null) {
    const current = naive; // items are already in the stored route order
    const k = items.findIndex((i) => i.id === opts.later);
    if (k < 0) throw notFound();
    order = bestInsertion(problem, current.filter((x) => x !== k), k, 1);
  } else {
    const priority = new Set(items.map((it, k) => (it.source === 'CARRY' || it.source === 'PREORDER' ? k : -1)).filter((k) => k >= 0));
    const r = solveWithPriority(problem, priority, s.priorityDetourKm * 1000);
    order = r.order;
    priorityFirst = r.priorityFirst;
  }

  const ev = evaluate(problem, order);
  const naiveEv = evaluate(problem, naive);
  const totalKm = Math.round(ev.meters / 100) / 10;
  const naiveKm = Math.round(naiveEv.meters / 100) / 10;
  const savedKm = Math.max(0, Math.round((naiveKm - totalKm) * 10) / 10);
  const routeStops: RouteStop[] = order.map((k, n) => ({
    itemId: items[k].id,
    shopId: items[k].shopId,
    name: items[k].shop.name,
    lat: items[k].shop.lat!,
    lng: items[k].shop.lng!,
    etaMin: Math.round(ev.arrivals[n]),
    legKm: Math.round(ev.legs[n] / 100) / 10,
  }));
  const route: StoredRoute = {
    stops: routeStops,
    totalKm,
    totalMin: Math.round(ev.minutes),
    naiveKm,
    savedKm,
    fuelSaved: fuelCost(savedKm, s.fuelPer100Km, s.fuelPrice),
    fuelCost: fuelCost(totalKm, s.fuelPer100Km, s.fuelPrice),
    approximate: m.approximate,
    priorityFirst,
    start: startPos ? { ...startPos, label: opts.start ? 'Siz turgan joy' : 'Ombor' } : null,
    end: endPos ? { ...endPos, label: s.routeEnd === 'home' ? 'Uy' : 'Ombor' } : null,
    path: [...(startPos ? [[startPos.lat, startPos.lng] as [number, number]] : []), ...routeStops.map((r) => [r.lat, r.lng] as [number, number]), ...(endPos ? [[endPos.lat, endPos.lng] as [number, number]] : [])],
    computedAt: ctx.now().toISOString(),
  };

  await inTx(ctx.db, async (tx) => {
    for (const [n, st] of routeStops.entries()) {
      await tx.checklistItem.update({ where: { id: st.itemId }, data: { position: n + 1, etaMin: st.etaMin, legKm: st.legKm } });
    }
    // Planned km is the morning plan; re-plans during the day only change the remaining route
    const done = await tx.checklistItem.count({ where: { checklistId, status: { not: 'PENDING' } } });
    await tx.checklist.update({ where: { id: checklistId }, data: { route: route as never, ...(done === 0 || list.plannedKm == null ? { plannedKm: totalKm, plannedMin: route.totalMin } : {}) } });
  });
  return route;
}
