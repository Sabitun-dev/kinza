// Route order solver. Pure functions, no database.
//
// Points are indices into a distance (metres) and time (seconds) matrix. Index `start` is where the
// day begins; `end` is where it must finish (or null = finish at the last shop).
// Cost = total distance + route time (waiting included) + a very large penalty for each minute late
// against a shop's opening hours, so a feasible route always wins over a shorter infeasible one.

export interface Stop {
  /** Matrix index of this stop. */
  index: number;
  /** Earliest arrival, minutes after midnight (opening time or "not before"). */
  earliest?: number | null;
  /** Latest arrival, minutes after midnight (closing time). */
  latest?: number | null;
  /** Minutes spent at the shop. */
  service: number;
}

export interface Problem {
  dist: number[][];
  time: number[][];
  start: number;
  end: number | null;
  stops: Stop[];
  /** Departure time, minutes after midnight. */
  departAt: number;
}

export interface Evaluation {
  meters: number;
  /** Driving + waiting + service, minutes. */
  minutes: number;
  lateMinutes: number;
  cost: number;
  /** Arrival time at each stop, minutes after midnight (same order as the route). */
  arrivals: number[];
  /** Metres of each leg (to each stop, then to the end if any). */
  legs: number[];
}

const LATE_PENALTY = 1_000_000; // per minute late: feasibility first
/** One minute of the driver's time is worth this many metres (idle waiting is not free). */
const METERS_PER_MINUTE = 150;

/** Simulates a route (stop positions in `order`) and prices it. */
export function evaluate(p: Problem, order: number[]): Evaluation {
  let at = p.start;
  let t = p.departAt;
  let meters = 0;
  let late = 0;
  const arrivals: number[] = [];
  const legs: number[] = [];
  for (const k of order) {
    const s = p.stops[k];
    const d = p.dist[at][s.index];
    meters += d;
    legs.push(d);
    t += p.time[at][s.index] / 60;
    if (s.earliest != null && t < s.earliest) t = s.earliest; // wait until it opens
    if (s.latest != null && t > s.latest) late += t - s.latest;
    arrivals.push(t);
    t += s.service;
    at = s.index;
  }
  if (p.end != null) {
    const d = p.dist[at][p.end];
    meters += d;
    legs.push(d);
    t += p.time[at][p.end] / 60;
  }
  return { meters, minutes: t - p.departAt, lateMinutes: late, cost: meters + (t - p.departAt) * METERS_PER_MINUTE + late * LATE_PENALTY, arrivals, legs };
}

const cost = (p: Problem, order: number[]) => evaluate(p, order).cost;

/** Greedy start: always drive to the nearest stop that is not yet too late. */
export function nearestNeighbour(p: Problem): number[] {
  const left = new Set(p.stops.map((_, k) => k));
  const order: number[] = [];
  let at = p.start;
  let t = p.departAt;
  while (left.size) {
    let best = -1;
    let bestScore = Infinity;
    for (const k of left) {
      const s = p.stops[k];
      const arrive = Math.max(t + p.time[at][s.index] / 60, s.earliest ?? 0);
      const late = s.latest != null && arrive > s.latest ? arrive - s.latest : 0;
      const score = p.dist[at][s.index] + late * LATE_PENALTY + (arrive - t) * 0.001;
      if (score < bestScore) {
        bestScore = score;
        best = k;
      }
    }
    order.push(best);
    left.delete(best);
    const s = p.stops[best];
    t = Math.max(t + p.time[at][s.index] / 60, s.earliest ?? 0) + s.service;
    at = s.index;
  }
  return order;
}

/** 2-opt: reverse a segment when it makes the route cheaper. Never accepts a worse route. */
export function twoOpt(p: Problem, order: number[], deadline = Infinity): number[] {
  let best = [...order];
  let bestCost = cost(p, best);
  let improved = true;
  while (improved && Date.now() < deadline) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const cand = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const c = cost(p, cand);
        if (c < bestCost - 1e-6) {
          best = cand;
          bestCost = c;
          improved = true;
        }
      }
    }
  }
  return best;
}

/** Or-opt: move a chain of 1–3 stops to another place in the route. */
export function orOpt(p: Problem, order: number[], deadline = Infinity): number[] {
  let best = [...order];
  let bestCost = cost(p, best);
  let improved = true;
  while (improved && Date.now() < deadline) {
    improved = false;
    for (let len = 1; len <= 3; len++) {
      for (let i = 0; i + len <= best.length; i++) {
        const chain = best.slice(i, i + len);
        const rest = [...best.slice(0, i), ...best.slice(i + len)];
        for (let j = 0; j <= rest.length; j++) {
          if (j === i) continue;
          const cand = [...rest.slice(0, j), ...chain, ...rest.slice(j)];
          const c = cost(p, cand);
          if (c < bestCost - 1e-6) {
            best = cand;
            bestCost = c;
            improved = true;
          }
        }
      }
    }
  }
  return best;
}

/** Exact: branch and bound over every order (used for 10 stops or fewer). */
export function exact(p: Problem, initial?: number[], deadline = Date.now() + 2000): number[] {
  const n = p.stops.length;
  let bestOrder = initial ?? nearestNeighbour(p);
  let bestCost = cost(p, bestOrder);
  const used = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  let nodes = 0;
  let stopped = false;
  const dfs = (at: number, t: number, meters: number, late: number) => {
    if (stopped || (++nodes % 20_000 === 0 && Date.now() > deadline && (stopped = true))) return;
    const partial = meters + (t - p.departAt) * METERS_PER_MINUTE + late * LATE_PENALTY;
    if (partial >= bestCost) return; // cannot beat the best: distances only grow
    if (order.length === n) {
      const total = cost(p, order);
      if (total < bestCost) {
        bestCost = total;
        bestOrder = [...order];
      }
      return;
    }
    for (let k = 0; k < n; k++) {
      if (used[k]) continue;
      const s = p.stops[k];
      let arrive = t + p.time[at][s.index] / 60;
      if (s.earliest != null && arrive < s.earliest) arrive = s.earliest;
      const l = s.latest != null && arrive > s.latest ? arrive - s.latest : 0;
      used[k] = true;
      order.push(k);
      dfs(s.index, arrive + s.service, meters + p.dist[at][s.index], late + l);
      order.pop();
      used[k] = false;
    }
  };
  dfs(p.start, p.departAt, 0, 0);
  return bestOrder;
}

/** Best order of the stops: exact up to 10 stops, otherwise NN + 2-opt + or-opt within the time limit. */
export function solve(p: Problem, timeLimitMs = 2000): number[] {
  if (p.stops.length <= 1) return p.stops.map((_, k) => k);
  if (p.stops.length <= 10) return exact(p, orOpt(p, twoOpt(p, nearestNeighbour(p))), Date.now() + timeLimitMs); // a good first bound prunes most orders
  const deadline = Date.now() + timeLimitMs;
  let order = nearestNeighbour(p);
  let c = cost(p, order);
  while (Date.now() < deadline) {
    const next = orOpt(p, twoOpt(p, order, deadline), deadline);
    const nc = cost(p, next);
    if (nc >= c - 1e-6) break;
    order = next;
    c = nc;
  }
  return order;
}

/**
 * Puts priority stops (yesterday's leftovers, pre-orders) first when that costs at most
 * `maxExtraMeters` more than the free best order.
 */
export function solveWithPriority(p: Problem, priority: Set<number>, maxExtraMeters: number, timeLimitMs = 2000): { order: number[]; priorityFirst: boolean } {
  const free = solve(p, timeLimitMs / 2);
  if (!priority.size || priority.size === p.stops.length) return { order: free, priorityFirst: false };
  const pri = p.stops.map((_, k) => k).filter((k) => priority.has(k));
  const rest = p.stops.map((_, k) => k).filter((k) => !priority.has(k));
  // Order the priority group from the start, then the rest from the last priority stop
  const first = solve({ ...p, end: null, stops: pri.map((k) => p.stops[k]) }, timeLimitMs / 4).map((i) => pri[i]);
  const firstEval = evaluate(p, first);
  const lastIndex = p.stops[first[first.length - 1]].index;
  const second = solve({ ...p, start: lastIndex, departAt: p.departAt + firstEval.minutes, stops: rest.map((k) => p.stops[k]) }, timeLimitMs / 4).map((i) => rest[i]);
  const forced = [...first, ...second];
  const a = evaluate(p, free);
  const b = evaluate(p, forced);
  if (b.lateMinutes <= a.lateMinutes && b.meters - a.meters <= maxExtraMeters) return { order: forced, priorityFirst: true };
  return { order: free, priorityFirst: false };
}

/** Best position to re-insert one stop ("Keyinroq qaytaman"), never before `from`. */
export function bestInsertion(p: Problem, order: number[], stop: number, from: number): number[] {
  let best: number[] | null = null;
  let bestCost = Infinity;
  for (let j = Math.max(from, 0); j <= order.length; j++) {
    const cand = [...order.slice(0, j), stop, ...order.slice(j)];
    const c = cost(p, cand);
    if (c < bestCost) {
      bestCost = c;
      best = cand;
    }
  }
  return best ?? [...order, stop];
}

/** Fuel money for a distance: km × litres per 100 km × price per litre. */
export function fuelCost(km: number, litresPer100: number, pricePerLitre: number): number {
  return Math.round(((km * litresPer100) / 100) * pricePerLitre);
}

/** "HH:MM" → minutes after midnight (null if empty). */
export function hhmmToMin(s: string | null | undefined): number | null {
  if (!s) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
