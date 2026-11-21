import type { Ctx } from '../core/context.ts';
import type { DbOrTx, Tx } from '../core/db.ts';
import { inTx } from '../core/db.ts';
import type { Settings } from '../core/settings.ts';
import { AppError, bad, notFound } from '../core/errors.ts';
import { audit } from '../core/audit.ts';
import type { ChecklistSource, ChecklistStatus } from '../generated/prisma/enums.ts';
import { addDays, daysBetween, fromDbDate, localDate, nextWeekday, toDbDate, weekday, weekParityOf } from '../shared/dates.ts';

// The daily shop checklist: a stored snapshot of every shop due today, so no shop is forgotten.
// Due today = area's weekday (+ odd/even week) and the shop's frequency, plus shops carried over
// from earlier days, plus planned pre-order deliveries.

export const DONE: ChecklistStatus[] = ['SOLD', 'DELIVERED', 'NO_ORDER', 'CLOSED', 'MOVED'];
export const VISITED: ChecklistStatus[] = ['SOLD', 'DELIVERED', 'NO_ORDER'];

type Who = { id: number; role: 'OWNER' | 'AGENT' | 'DRIVER' };

// ───────────── Working days ─────────────

export async function holidaySet(db: DbOrTx, from: string, to: string) {
  const rows = await db.holiday.findMany({ where: { date: { gte: toDbDate(from), lte: toDbDate(to) } } });
  return new Set(rows.map((r) => fromDbDate(r.date)!));
}

export function isDayOffSync(s: Settings, holidays: Set<string>, date: string) {
  return (s.weeklyDayOff > 0 && weekday(date) === s.weeklyDayOff) || holidays.has(date);
}

export async function isDayOff(db: DbOrTx, s: Settings, date: string) {
  return isDayOffSync(s, await holidaySet(db, date, date), date);
}

export async function nextWorkingDay(db: DbOrTx, s: Settings, date: string) {
  const h = await holidaySet(db, addDays(date, 1), addDays(date, 40));
  let d = addDays(date, 1);
  while (isDayOffSync(s, h, d)) d = addDays(d, 1);
  return d;
}

export async function workingDayOnOrAfter(db: DbOrTx, s: Settings, date: string) {
  return (await isDayOff(db, s, date)) ? nextWorkingDay(db, s, date) : date;
}

async function prevWorkingDay(db: DbOrTx, s: Settings, date: string) {
  const h = await holidaySet(db, addDays(date, -40), addDays(date, -1));
  let d = addDays(date, -1);
  while (isDayOffSync(s, h, d)) d = addDays(d, -1);
  return d;
}

// ───────────── Who is due ─────────────

export interface DueShop {
  frequency: 'WEEKLY' | 'BIWEEKLY';
  weekParity: 'ODD' | 'EVEN' | null;
  district: { routeDay: number | null; weekParity: 'ODD' | 'EVEN' | null } | null;
}

/** Is this shop due on this date by its area's weekday, the area's week and its own frequency? */
export function isShopDue(shop: DueShop, date: string) {
  const d = shop.district;
  if (!d || d.routeDay !== weekday(date)) return false;
  const parity = weekParityOf(date);
  if (d.weekParity) return d.weekParity === parity; // the area itself is every 2 weeks (A1 / A2)
  if (shop.frequency === 'BIWEEKLY') return (shop.weekParity ?? 'ODD') === parity;
  return true;
}

/** Shops this person is responsible for. The owner covers shops without an agent. */
export function shopsOf(u: Who) {
  if (u.role === 'AGENT') return { agentId: u.id };
  return { OR: [{ agentId: null }, { agentId: u.id }] };
}

const activeShop = { archivedAt: null, status: { not: 'INACTIVE' as const } };

/** Shops that cannot be planned: missing area, frequency or map pin. */
export async function shopsWithProblems(db: DbOrTx, u: Who) {
  const shops = await db.shop.findMany({
    where: { ...activeShop, ...shopsOf(u), OR: [{ districtId: null }, { lat: null }, { lng: null }] },
    select: { id: true, name: true, districtId: true, lat: true },
  });
  return shops.map((s) => ({ id: s.id, name: s.name, missing: [!s.districtId && 'hudud', s.lat == null && 'joylashuv'].filter(Boolean) as string[] }));
}

// ───────────── Creating the day's checklist ─────────────

export async function ensureChecklist(db: DbOrTx, s: Settings, u: Who, date: string) {
  const existing = await db.checklist.findUnique({ where: { userId_date: { userId: u.id, date: toDbDate(date) } } });
  if (existing) return existing;
  if (await isDayOff(db, s, date)) return null;
  try {
    return await inTx(db, (tx) => createChecklist(tx, s, u, date));
  } catch (e) {
    const again = await db.checklist.findUnique({ where: { userId_date: { userId: u.id, date: toDbDate(date) } } });
    if (again) return again; // created in parallel
    throw e;
  }
}

/** Which shops belong on a day's list (not saved). */
async function computeItems(tx: DbOrTx, s: Settings, u: Who, date: string) {
  // Days since the previous working day (days off roll their shops over to today)
  const prev = await prevWorkingDay(tx, s, date);
  const days: string[] = [];
  for (let d = addDays(prev, 1); d <= date; d = addDays(d, 1)) days.push(d);

  const shops = await tx.shop.findMany({
    where: { ...activeShop, ...shopsOf(u), districtId: { not: null }, lat: { not: null } },
    include: { district: true },
  });
  const items = new Map<number, { shopId: number; source: ChecklistSource; carryCount: number; orderId?: number; reason?: string | null }>();
  const areaIds = new Set<number>();
  for (const shop of shops) {
    if (days.some((d) => isShopDue(shop, d))) {
      items.set(shop.id, { shopId: shop.id, source: 'ROUTE', carryCount: 0 });
      areaIds.add(shop.districtId!);
    }
  }

  // Carried over / moved to this day
  const carried = await tx.checklistItem.findMany({
    where: { status: 'MOVED', carriedOn: false, movedTo: { lte: toDbDate(date) }, checklist: { userId: u.id } },
  });
  for (const c of carried) {
    items.set(c.shopId, { shopId: c.shopId, source: c.autoCarried ? 'CARRY' : 'MOVED', carryCount: c.autoCarried ? c.carryCount + 1 : 0, reason: c.reason });
  }

  // Pre-orders to deliver today (or late ones)
  const preorders = await tx.order.findMany({
    where: { status: { in: ['CONFIRMED', 'IN_TRANSIT'] }, deliveryDate: { lte: toDbDate(date) }, shop: shopsOf(u) },
    select: { id: true, shopId: true },
  });
  for (const o of preorders) {
    const prevItem = items.get(o.shopId);
    items.set(o.shopId, { shopId: o.shopId, source: 'PREORDER', carryCount: prevItem?.carryCount ?? 0, orderId: o.id });
  }

  return { items, areaIds, carried };
}

async function createChecklist(tx: Tx, s: Settings, u: Who, date: string) {
  const { items, areaIds, carried } = await computeItems(tx, s, u, date);
  const list = await tx.checklist.create({
    data: {
      userId: u.id,
      date: toDbDate(date),
      areaIds: [...areaIds],
      items: { create: [...items.values()] },
    },
  });
  if (carried.length) await tx.checklistItem.updateMany({ where: { id: { in: carried.map((c) => c.id) } }, data: { carriedOn: true } });
  return list;
}

/**
 * Tomorrow's list before it exists (for the 20:00 message): due shops, pre-orders, earlier moves,
 * and today's ⏳ shops that will be carried over at 23:00.
 */
export async function previewChecklist(db: DbOrTx, s: Settings, u: Who, date: string, today: string) {
  const { items, areaIds } = await computeItems(db, s, u, date);
  const leftToday = await db.checklistItem.findMany({ where: { status: 'PENDING', checklist: { userId: u.id, date: toDbDate(today) } } });
  if (date === (await nextWorkingDay(db, s, today))) {
    for (const i of leftToday) if (!items.has(i.shopId)) items.set(i.shopId, { shopId: i.shopId, source: 'CARRY', carryCount: i.carryCount + 1 });
  }
  const shops = await db.shop.findMany({ where: { id: { in: [...items.keys()] } }, select: { id: true, name: true, lat: true, lng: true, priority: true } });
  const areas = await db.district.findMany({ where: { id: { in: [...areaIds] } } });
  const name = new Map(shops.map((x) => [x.id, x]));
  const rank: Record<string, number> = { CARRY: 0, PREORDER: 1, MOVED: 2, ROUTE: 3, NEW: 4 };
  const list = [...items.values()]
    .map((i) => ({ ...i, name: name.get(i.shopId)?.name ?? '' }))
    .sort((a, b) => rank[a.source] - rank[b.source] || a.name.localeCompare(b.name));
  return { date, areas: areas.map((a) => a.name), items: list };
}

/** A shop created or moved into today's area during the day is added with a "Yangi" badge. */
export async function addShopIfDueToday(db: DbOrTx, s: Settings, u: Who, shopId: number, today: string) {
  const list = await db.checklist.findUnique({ where: { userId_date: { userId: u.id, date: toDbDate(today) } } });
  if (!list || list.closedAt) return;
  const shop = await db.shop.findUnique({ where: { id: shopId }, include: { district: true } });
  if (!shop || shop.archivedAt || shop.status === 'INACTIVE' || shop.lat == null || !isShopDue(shop, today)) return;
  await db.checklistItem.upsert({
    where: { checklistId_shopId: { checklistId: list.id, shopId } },
    create: { checklistId: list.id, shopId, source: 'NEW' },
    update: {},
  });
}

/** Today's row for a shop (created as NEW if the shop was not planned). Used by "Sotish". */
export async function itemForShop(tx: Tx, s: Settings, u: Who, shopId: number, today: string) {
  const list = await ensureChecklist(tx, s, u, today);
  if (!list) return null;
  return tx.checklistItem.upsert({
    where: { checklistId_shopId: { checklistId: list.id, shopId } },
    create: { checklistId: list.id, shopId, source: 'NEW' },
    update: {},
  });
}

export async function setItemStatus(tx: Tx, itemId: number, status: ChecklistStatus, extra: { reason?: string | null; orderId?: number; visitId?: number; at: Date }) {
  return tx.checklistItem.update({
    where: { id: itemId },
    data: { status, reason: extra.reason ?? undefined, orderId: extra.orderId, visitId: extra.visitId, doneAt: extra.at },
  });
}

// ───────────── Quick actions ─────────────

async function ownItem(ctx: Ctx, itemId: number) {
  const item = await ctx.db.checklistItem.findUnique({ where: { id: itemId }, include: { checklist: true, shop: true } });
  if (!item || (item.checklist.userId !== ctx.user.id && ctx.user.role !== 'OWNER')) throw notFound();
  return item;
}

export async function markNoVisitOutcome(ctx: Ctx, itemId: number, kind: 'NO_ORDER' | 'CLOSED', reason: string | null, pos?: { lat: number; lng: number } | null) {
  const item = await ownItem(ctx, itemId);
  return inTx(ctx.db, async (tx) => {
    const visit = await tx.visit.create({
      data: { shopId: item.shopId, userId: ctx.user.id, result: kind, reason, note: reason, lat: pos?.lat, lng: pos?.lng, visitedAt: ctx.now() },
    });
    await setItemStatus(tx, itemId, kind, { reason, visitId: visit.id, at: ctx.now() });
    await audit(tx, ctx.user.id, `checklist.${kind.toLowerCase()}`, 'shop', item.shopId, undefined, { reason });
    return { ok: true };
  });
}

/** "Boshqa kunga": the shop moves to another working day. The reason is required. */
export async function moveItem(ctx: Ctx, itemId: number, date: string, reason: string, auto = false) {
  if (!reason?.trim()) throw bad('Sababini yozing');
  const item = await ownItem(ctx, itemId);
  const listDate = fromDbDate(item.checklist.date)!;
  if (date <= listDate) throw bad('Keyingi kunlardan birini tanlang');
  const target = await workingDayOnOrAfter(ctx.db, ctx.settings, date);
  return inTx(ctx.db, (tx) => moveInTx(tx, ctx.settings, item, target, reason, auto));
}

async function moveInTx(tx: Tx, s: Settings, item: { id: number; shopId: number; carryCount: number; checklist: { userId: number } }, target: string, reason: string, auto: boolean) {
  await tx.checklistItem.update({ where: { id: item.id }, data: { status: 'MOVED', movedTo: toDbDate(target), reason, autoCarried: auto, doneAt: new Date() } });
  // If the target day's list already exists, add the shop there right away
  const later = await tx.checklist.findUnique({ where: { userId_date: { userId: item.checklist.userId, date: toDbDate(target) } } });
  if (later && !later.closedAt) {
    await tx.checklistItem.upsert({
      where: { checklistId_shopId: { checklistId: later.id, shopId: item.shopId } },
      create: { checklistId: later.id, shopId: item.shopId, source: auto ? 'CARRY' : 'MOVED', carryCount: auto ? item.carryCount + 1 : 0, reason },
      update: {},
    });
    await tx.checklistItem.update({ where: { id: item.id }, data: { carriedOn: true } });
  }
  return { movedTo: target };
}

export type CloseChoice = 'tomorrow' | 'friday' | 'nextweek' | 'visited';

/** "Kun yakuni": every ⏳ shop needs a decision; the day cannot close while any shop is ⏳. */
export async function closeDay(ctx: Ctx, checklistId: number, decisions: { itemId: number; choice: CloseChoice }[]) {
  const list = await ctx.db.checklist.findUnique({ where: { id: checklistId } });
  if (!list || (list.userId !== ctx.user.id && ctx.user.role !== 'OWNER')) throw notFound();
  const date = fromDbDate(list.date)!;
  const s = ctx.settings;
  for (const d of decisions) {
    const item = await ctx.db.checklistItem.findFirst({ where: { id: d.itemId, checklistId }, include: { checklist: true } });
    if (!item || item.status !== 'PENDING') continue;
    if (d.choice === 'visited') {
      await markNoVisitOutcome(ctx, item.id, 'NO_ORDER', 'Bordim (kun yakunida belgilandi)');
      continue;
    }
    const target =
      d.choice === 'tomorrow'
        ? await nextWorkingDay(ctx.db, s, date)
        : d.choice === 'friday'
          ? await workingDayOnOrAfter(ctx.db, s, nextWeekday(date, s.preorderWeekday))
          : await workingDayOnOrAfter(ctx.db, s, addDays(date, 7));
    await inTx(ctx.db, (tx) => moveInTx(tx, s, item, target, d.choice === 'tomorrow' ? 'Kun yakunida: ertaga' : d.choice === 'friday' ? 'Kun yakunida: juma' : 'Kun yakunida: keyingi hafta', d.choice === 'tomorrow'));
  }
  const pending = await ctx.db.checklistItem.findMany({ where: { checklistId, status: 'PENDING' }, include: { shop: { select: { name: true } } } });
  if (pending.length) {
    throw new AppError(`Hali ${pending.length} ta do'kon belgilanmagan: ${pending.map((p) => p.shop.name).join(', ')}`, 409, 'pending_shops', { items: pending.map((p) => ({ id: p.id, name: p.shop.name })) });
  }
  await ctx.db.checklist.update({ where: { id: checklistId }, data: { closedAt: ctx.now() } });
  await audit(ctx.db, ctx.user.id, 'checklist.close', 'checklist', checklistId);
  return { ok: true };
}

/** 23:00: every ⏳ shop moves to the next working day ("Kecha qolgan"). */
export async function autoCarryOver(db: DbOrTx, s: Settings, today: string) {
  const items = await db.checklistItem.findMany({
    where: { status: 'PENDING', checklist: { date: { lte: toDbDate(today) } } },
    include: { checklist: true },
  });
  let n = 0;
  for (const item of items) {
    const target = await nextWorkingDay(db, s, fromDbDate(item.checklist.date)! < today ? today : fromDbDate(item.checklist.date)!);
    await inTx(db, (tx) => moveInTx(tx, s, item, target, 'Avtomatik (kun oxirida qolgan)', true));
    n++;
  }
  return n;
}

// ───────────── Coverage ("Qamrov") ─────────────

export async function coverage(db: DbOrTx, u: Who, from: string, to: string, today: string) {
  const items = await db.checklistItem.findMany({
    where: { checklist: { userId: u.id, date: { gte: toDbDate(from), lte: toDbDate(to) } } },
    include: { shop: { select: { id: true, name: true, address: true } }, checklist: { select: { date: true } } },
  });
  const due = new Map<number, { shop: { id: number; name: string; address: string | null }; dueDate: string }>();
  const visited = new Set<number>();
  for (const i of items) {
    if (i.source === 'ROUTE' || i.source === 'NEW') {
      const d = fromDbDate(i.checklist.date)!;
      if (!due.has(i.shopId) || due.get(i.shopId)!.dueDate > d) due.set(i.shopId, { shop: i.shop, dueDate: d });
    }
    if (VISITED.includes(i.status)) visited.add(i.shopId);
  }
  const missedIds = [...due.keys()].filter((id) => !visited.has(id));
  const lastVisits = await db.visit.groupBy({ by: ['shopId'], where: { shopId: { in: missedIds } }, _max: { visitedAt: true } });
  const lv = new Map(lastVisits.map((v) => [v.shopId, v._max.visitedAt]));
  const missed = missedIds.map((id) => {
    const last = lv.get(id);
    return { ...due.get(id)!.shop, dueDate: due.get(id)!.dueDate, lastVisit: last ?? null, daysSinceVisit: last ? daysBetween(localDate(last), today) : null };
  });
  const dueCount = due.size;
  const visitedCount = [...due.keys()].filter((id) => visited.has(id)).length;
  return { from, to, due: dueCount, visited: visitedCount, percent: dueCount ? Math.round((visitedCount / dueCount) * 100) : 100, missed: missed.sort((a, b) => (b.daysSinceVisit ?? 999) - (a.daysSinceVisit ?? 999)) };
}

/** Shops with no visit for longer than their frequency + 3 days (red on the shops list). */
export function isVisitLate(frequency: 'WEEKLY' | 'BIWEEKLY', lastVisit: Date | null | undefined, createdAt: Date, today: string) {
  const limit = (frequency === 'BIWEEKLY' ? 14 : 7) + 3;
  const since = lastVisit ?? createdAt;
  return daysBetween(localDate(since), today) > limit;
}
