import type { Ctx, Deps } from '../core/context.ts';
import type { Settings } from '../core/settings.ts';
import type { Button } from '../core/notifier.ts';
import { esc } from '../core/notifier.ts';
import type { Message } from './digests.ts';
import { coverage, ensureChecklist, nextWorkingDay, previewChecklist, shopsWithProblems } from '../checklist/checklist.ts';
import { checklistView } from '../checklist/view.ts';
import { planRoute } from '../routing/route.ts';
import { loadingProposal } from '../domain/van.ts';
import { buildProposal } from '../domain/supplier.ts';
import { stockLevels } from '../domain/stockLevels.ts';
import { addDays, formatDateHuman, toDbDate, weekday, WEEKDAYS_UZ } from '../shared/dates.ts';
import { formatMoney } from '../shared/money.ts';
import { formatQty } from '../shared/qty.ts';

// Bot messages for the van-sales day (owner and agents). Shop names, in route order.

export interface Person {
  id: number;
  telegramId: bigint;
  role: 'OWNER' | 'AGENT' | 'DRIVER';
  name: string;
}

export function personCtx(deps: Deps, s: Settings, u: Person): Ctx {
  return { db: deps.db, settings: s, blobs: deps.blobs, notifier: deps.notifier, now: deps.now, http: deps.http, user: { id: u.id, telegramId: Number(u.telegramId), name: u.name, role: u.role, active: true } };
}

const MAX_NAMES = 25;

function numbered(names: { name: string; tag?: string }[]) {
  const lines = names.slice(0, MAX_NAMES).map((n, i) => `${i + 1}. ${esc(n.name)}${n.tag ? ` <i>(${n.tag})</i>` : ''}`);
  if (names.length > MAX_NAMES) lines.push(`… va yana ${names.length - MAX_NAMES} ta`);
  return lines.join('\n');
}

/** 08:00 — "Bugun: B hudud — 18 ta do'kon", names in route order, km, car loading, money to collect. */
export async function morningVan(deps: Deps, s: Settings, u: Person, day: string): Promise<Message | null> {
  const ctx = personCtx(deps, s, u);
  const list = await ensureChecklist(deps.db, s, u, day);
  if (!list) return null; // day off
  // Plan from the warehouse so the order and km are known before leaving (re-planned from GPS later)
  if (!list.route && s.warehouseLat != null) {
    try {
      await planRoute(ctx, list.id);
    } catch {
      /* no shops or routing problem: the list still goes out */
    }
  }
  const fresh = await deps.db.checklist.findUniqueOrThrow({ where: { id: list.id } });
  const view = await checklistView(deps.db, s, fresh, u.id);
  const parts: string[] = [];
  const area = view.areas.length ? `${view.areas.join(', ')} hudud` : "do'konlar";
  parts.push(`☀️ <b>Bugun: ${esc(area)} — ${view.total} ta do'kon</b>`);
  if (view.total) {
    parts.push(
      numbered(
        view.items.map((i) => ({
          name: i.shop.name,
          tag: i.source === 'CARRY' ? 'Kecha qolgan' : i.source === 'PREORDER' ? 'buyurtma' : i.source === 'NEW' ? 'yangi' : undefined,
        })),
      ),
    );
  }
  if (view.plannedKm != null) parts.push(`\n🚗 Reja: <b>${view.plannedKm} km</b>${(view.route as any)?.savedKm ? ` (tejaldi ${(view.route as any).savedKm} km)` : ''}`);
  if (view.toCollect > 0) parts.push(`💰 Yig'iladigan qarz: <b>${formatMoney(view.toCollect)}</b>`);

  const load = await loadingProposal(ctx, day);
  const toLoad = load.lines.filter((l) => l.proposedPacks > 0);
  if (toLoad.length) parts.push(`🚚 Yuklash: ${esc(toLoad.map((l) => `${l.flavour} ${l.proposedPacks}`).join(', '))} (jami ${load.totalPacks} blok)`);

  const twice = view.items.filter((i) => i.carryCount >= 2 && i.status === 'PENDING');
  if (twice.length) parts.push(`\n⚠️ <b>${twice.length} ta do'kon ketma-ket qoldirilgan:</b> ${esc(twice.map((i) => `${i.shop.name} (${i.carryCount} marta)`).join(', '))}`);

  const problems = await shopsWithProblems(deps.db, u);
  if (problems.length) parts.push(`❗ ${problems.length} ta do'konda hudud yoki joylashuv yo'q: ${esc(problems.slice(0, 5).map((p) => p.name).join(', '))}`);

  if (u.role === 'OWNER') {
    const products = await deps.db.product.findMany({ where: { archivedAt: null } });
    const levels = await stockLevels(deps.db, products.map((p) => p.id));
    const low = products.filter((p) => levels.get(p.id)!.available < s.lowStockPacks * p.packSize);
    if (low.length) parts.push(`📦 Kam qoldi: ${esc(low.map((p) => `${p.flavour} (${formatQty(levels.get(p.id)!.available, p.packSize)})`).join(', '))}`);
    const exp = await deps.db.stockBatch.count({ where: { remainingCans: { gt: 0 }, expiry: { lte: toDbDate(addDays(day, s.expiryWarnDays)) } } });
    if (exp) parts.push(`⏳ Muddati yaqin partiyalar: ${exp} ta`);
  }
  const reminders = await deps.db.reminder.count({ where: { userId: u.id, doneAt: null, dueDate: { lte: toDbDate(day) }, OR: [{ snoozedTo: null }, { snoozedTo: { lte: toDbDate(day) } }] } });
  if (reminders) parts.push(`🔔 Eslatmalar: ${reminders} ta`);

  const buttons: Button[][] = [[{ text: 'Ochish', app: 'today' }]];
  if (toLoad.length) buttons.push([{ text: '🚚 Mashinani yuklash', app: 'load' }]);
  if (view.total) buttons.push([{ text: "🚗 Yo'lga chiqish", app: 'drive' }]);
  return { text: parts.join('\n'), buttons };
}

/** 17:00 — "Hali 4 ta do'kon qoldi: …" */
export async function middayVan(deps: Deps, _s: Settings, u: Person, day: string): Promise<Message | null> {
  const list = await deps.db.checklist.findUnique({ where: { userId_date: { userId: u.id, date: toDbDate(day) } } });
  if (!list || list.closedAt) return null;
  const left = await deps.db.checklistItem.findMany({ where: { checklistId: list.id, status: 'PENDING' }, include: { shop: { select: { name: true } } }, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
  if (!left.length) return null;
  return {
    text: `⏳ <b>Hali ${left.length} ta do'kon qoldi:</b> ${esc(left.map((l) => l.shop.name).join(', '))}`,
    buttons: [[{ text: 'Ochish', app: 'today' }]],
  };
}

/** 20:00 — Kun yakuni reminder, tomorrow's list, Thursday's Tashkent order, Saturday's coverage. */
export async function eveningVan(deps: Deps, s: Settings, u: Person, day: string): Promise<Message | null> {
  const ctx = personCtx(deps, s, u);
  const parts: string[] = [];
  const buttons: Button[][] = [];

  const list = await deps.db.checklist.findUnique({ where: { userId_date: { userId: u.id, date: toDbDate(day) } } });
  if (list && !list.closedAt) {
    const left = await deps.db.checklistItem.count({ where: { checklistId: list.id, status: 'PENDING' } });
    const cash = await deps.db.payment.aggregate({ where: { receivedById: u.id, handedOverAt: null, voidedAt: null }, _sum: { amount: true } });
    parts.push(`🏁 <b>Kun yakuni qilinmagan.</b>${left ? ` ${left} ta do'kon belgilanmagan.` : ''} Mashinadagi qoldiqni sanang${cash._sum.amount ? `, qo'ldagi pul: ${formatMoney(cash._sum.amount)}` : ''}.`);
    buttons.push([{ text: '🏁 Kun yakuni', app: 'dayclose' }]);
  }

  const tomorrow = await nextWorkingDay(deps.db, s, day);
  const pre = await previewChecklist(deps.db, s, u, tomorrow, day);
  const area = pre.areas.length ? `${pre.areas.join(', ')} hudud` : "do'konlar";
  parts.push(`${parts.length ? '\n' : ''}🌙 <b>${tomorrow === addDays(day, 1) ? 'Ertaga' : WEEKDAYS_UZ[weekday(tomorrow)]} (${formatDateHuman(tomorrow)}): ${esc(area)} — ${pre.items.length} ta do'kon</b>`);
  if (pre.items.length) parts.push(numbered(pre.items.map((i) => ({ name: i.name, tag: i.source === 'CARRY' ? 'bugun qolgan' : i.source === 'PREORDER' ? 'buyurtma' : undefined }))));

  if (u.role === 'OWNER' && weekday(day) === s.supplierOrderWeekday) {
    const p = await buildProposal(ctx);
    const lines = p.lines.filter((l) => l.proposedPacks > 0);
    if (lines.length) {
      parts.push(`\n📦 <b>Toshkentga buyurtma (${WEEKDAYS_UZ[weekday(p.arrivalDate)]} keladi): ${p.totals.packs} blok</b>`);
      parts.push(esc(lines.map((l) => `${l.flavour} ${l.proposedPacks}`).join(', ')));
      buttons.push([{ text: '📦 Toshkentga buyurtma', app: 'tashkent' }]);
    }
  }

  if (weekday(day) === 6) {
    const monday = addDays(day, -5);
    const cov = await coverage(deps.db, u, monday, day, day);
    if (cov.due) {
      parts.push(`\n📊 <b>Haftalik qamrov: ${cov.percent}%</b> (${cov.visited}/${cov.due})`);
      if (cov.missed.length) parts.push(`Borilmagan: ${esc(cov.missed.slice(0, 10).map((m) => `${m.name}${m.daysSinceVisit != null ? ` (${m.daysSinceVisit} kun)` : ''}`).join(', '))}`);
      buttons.push([{ text: '📊 Qamrov', app: 'coverage' }]);
    }
  }
  if (!buttons.length) buttons.push([{ text: 'Ochish', app: 'today' }]);
  return { text: parts.join('\n'), buttons };
}

