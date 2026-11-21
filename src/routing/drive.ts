import type { Ctx } from '../core/context.ts';
import type { DbOrTx } from '../core/db.ts';
import { notFound } from '../core/errors.ts';
import { audit } from '../core/audit.ts';
import { checklistView } from '../checklist/view.ts';
import { fromDbDate, startOfLocalDay, toDbDate } from '../shared/dates.ts';
import { haversineMeters } from './matrix.ts';
import { fuelCost } from './solver.ts';
import { planRoute } from './route.ts';

type Pos = { lat: number; lng: number } | null | undefined;

async function ownList(ctx: Ctx, checklistId: number) {
  const list = await ctx.db.checklist.findUnique({ where: { id: checklistId } });
  if (!list || list.userId !== ctx.user.id) throw notFound();
  return list;
}

/**
 * "Yo'lga chiqish": plans the route from my position and returns everything driving mode needs,
 * so the phone can keep it and work without internet.
 */
export async function startDrive(ctx: Ctx, checklistId: number, pos: Pos) {
  const list = await ownList(ctx, checklistId);
  const pending = await ctx.db.checklistItem.count({ where: { checklistId, status: 'PENDING' } });
  if (pending) await planRoute(ctx, checklistId, { start: pos ?? null });
  if (!list.startedAt) await ctx.db.checklist.update({ where: { id: checklistId }, data: { startedAt: ctx.now() } });
  return driveBundle(ctx, checklistId);
}

/** Route + every stop with the shop details shown on the driving card. */
export async function driveBundle(ctx: Ctx, checklistId: number) {
  const list = await ownList(ctx, checklistId);
  const view = await checklistView(ctx.db, ctx.settings, list, ctx.user.id);
  const shopIds = view.items.map((i) => i.shopId);
  const lastOrders = await ctx.db.order.findMany({
    where: { shopId: { in: shopIds }, status: 'DELIVERED', isOpening: false },
    orderBy: { deliveredAt: 'desc' },
    distinct: ['shopId'],
    include: { items: { include: { product: { select: { flavour: true } } } } },
  });
  const last = new Map(lastOrders.map((o) => [o.shopId, o]));
  return {
    ...view,
    stops: view.items.map((i) => {
      const o = last.get(i.shopId);
      return {
        ...i,
        lastOrder: o
          ? { date: o.deliveredAt, total: o.total, lines: o.items.filter((l) => l.qtyCans > 0).map((l) => ({ flavour: l.product.flavour, qtyCans: l.qtyCans, packSize: l.packSize, isBonus: l.isBonus })) }
          : null,
      };
    }),
    fuel: { per100: ctx.settings.fuelPer100Km, price: ctx.settings.fuelPrice },
  };
}

/** Km driven from the GPS points of one checklist (noise and bad fixes ignored). */
export function drivenMeters(points: { lat: number; lng: number; accuracy: number | null }[]) {
  let m = 0;
  let prev: { lat: number; lng: number } | null = null;
  for (const p of points) {
    if (p.accuracy != null && p.accuracy > 100) continue;
    if (prev) {
      const d = haversineMeters(prev, p);
      if (d < 25) continue; // standing still: GPS jitter
      if (d > 20_000) {
        prev = p; // a jump (app was closed for long) — do not count
        continue;
      }
      m += d;
    }
    prev = p;
  }
  return m;
}

async function updateDriven(db: DbOrTx, checklistId: number, userId: number) {
  const pts = await db.gpsPoint.findMany({ where: { checklistId, userId }, orderBy: { at: 'asc' } });
  const km = Math.round(drivenMeters(pts) / 100) / 10;
  await db.checklist.update({ where: { id: checklistId }, data: { drivenKm: km } });
  return km;
}

/** GPS points recorded while driving mode is open (sent in small batches; may arrive late). */
export async function recordGps(ctx: Ctx, checklistId: number, points: { lat: number; lng: number; accuracy?: number | null; at: string }[]) {
  await ownList(ctx, checklistId);
  if (points.length) {
    await ctx.db.gpsPoint.createMany({
      data: points.slice(0, 500).map((p) => ({ userId: ctx.user.id, checklistId, lat: p.lat, lng: p.lng, accuracy: p.accuracy ?? null, at: new Date(p.at) })),
    });
  }
  return { drivenKm: await updateDriven(ctx.db, checklistId, ctx.user.id) };
}

/** End of the route: totals, and the automatic fuel expense (editable / deletable later). */
export async function finishDrive(ctx: Ctx, checklistId: number) {
  const list = await ownList(ctx, checklistId);
  const drivenKm = await updateDriven(ctx.db, checklistId, ctx.user.id);
  const date = fromDbDate(list.date)!;
  const [items, collected] = await Promise.all([
    ctx.db.checklistItem.findMany({ where: { checklistId } }),
    ctx.db.payment.aggregate({ where: { voidedAt: null, receivedById: ctx.user.id, paidAt: { gte: startOfLocalDay(date) } }, _sum: { amount: true } }),
  ]);
  const fuel = fuelCost(drivenKm, ctx.settings.fuelPer100Km, ctx.settings.fuelPrice);
  let expenseId: number | null = null;
  if (drivenKm > 0 && ctx.user.role === 'OWNER') {
    const marker = `[auto:checklist:${checklistId}]`;
    const cat =
      (await ctx.db.expenseCategory.findFirst({ where: { name: { startsWith: "Yoqilg'i" }, archivedAt: null } })) ??
      (await ctx.db.expenseCategory.findFirst({ where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } }));
    if (cat) {
      const existing = await ctx.db.expense.findFirst({ where: { comment: { contains: marker } } });
      const comment = `Avtomatik: ${drivenKm} km yo'l ${marker}`;
      if (existing && !existing.voidedAt) {
        await ctx.db.expense.update({ where: { id: existing.id }, data: { amount: fuel, comment } });
        expenseId = existing.id;
      } else if (!existing) {
        const e = await ctx.db.expense.create({ data: { categoryId: cat.id, amount: fuel, date: toDbDate(date), comment, createdById: ctx.user.id } });
        expenseId = e.id;
        await audit(ctx.db, ctx.user.id, 'expense.autoFuel', 'expense', e.id, undefined, { drivenKm, fuel });
      }
    }
  }
  return {
    done: items.filter((i) => i.status !== 'PENDING').length,
    total: items.length,
    sold: items.filter((i) => i.status === 'SOLD' || i.status === 'DELIVERED').length,
    collected: collected._sum.amount ?? 0,
    plannedKm: list.plannedKm,
    drivenKm,
    fuel,
    expenseId,
  };
}

/** GPS points are kept 30 days. */
export async function cleanupGps(db: DbOrTx, now: Date) {
  const r = await db.gpsPoint.deleteMany({ where: { at: { lt: new Date(now.getTime() - 30 * 86_400_000) } } });
  return r.count;
}
