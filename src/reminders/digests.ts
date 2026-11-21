import type { Deps } from '../core/context.ts';
import type { Settings } from '../core/settings.ts';
import type { Button } from '../core/notifier.ts';
import { esc } from '../core/notifier.ts';
import { shopBalances, outstanding } from '../domain/ledger.ts';
import { stockLevels } from '../domain/stockLevels.ts';
import { addDays, daysBetween, formatDateHuman, fromDbDate, localDate, toDbDate, weekday, WEEKDAYS_UZ } from '../shared/dates.ts';
import { formatMoney } from '../shared/money.ts';
import { formatQty } from '../shared/qty.ts';
import type { Role } from '../generated/prisma/enums.ts';

interface Recipient {
  id: number;
  telegramId: bigint;
  role: Role;
  name: string;
}

export interface Message {
  text: string;
  buttons?: Button[][];
}

/** Which orders a person is responsible for. */
function orderFilter(u: Recipient) {
  if (u.role === 'OWNER') return {};
  if (u.role === 'AGENT') return { OR: [{ agentId: u.id }, { shop: { agentId: u.id } }] };
  return { OR: [{ driverId: u.id }, { driverId: null }] };
}
function shopFilter(u: Recipient) {
  if (u.role === 'OWNER') return {};
  if (u.role === 'AGENT') return { agentId: u.id };
  return { id: -1 }; // drivers get no shop-level alerts
}

async function deliveriesFor(deps: Deps, u: Recipient, day: string) {
  return deps.db.order.findMany({
    where: { status: { in: ['CONFIRMED', 'IN_TRANSIT'] }, deliveryDate: toDbDate(day), ...orderFilter(u) },
    include: { shop: true, items: { include: { product: true } } },
    orderBy: { id: 'asc' },
  });
}

function deliveryLine(o: Awaited<ReturnType<typeof deliveriesFor>>[number], showMoney: boolean) {
  const items = o.items
    .filter((i) => i.qtyCans > 0)
    .map((i) => `${i.product.flavour} ${formatQty(i.qtyCans, i.packSize)}${i.isBonus ? ' 🎁' : ''}`)
    .join(', ');
  return `• <b>${esc(o.shop.name)}</b>${showMoney ? ` — ${formatMoney(o.total)}` : ''}\n   ${esc(items)}`;
}

/** 08:00 — today's deliveries, money to collect, overdue debts, visits, stock warnings, reminders. */
export async function morningDigest(deps: Deps, s: Settings, u: Recipient, day: string): Promise<Message | null> {
  const parts: string[] = [`☀️ <b>Xayrli tong, ${esc(u.name.split(' ')[0])}!</b> ${WEEKDAYS_UZ[weekday(day)]}, ${formatDateHuman(day)}`];
  const buttons: Button[][] = [[{ text: 'Ochish', app: 'today' }]];

  const deliveries = await deliveriesFor(deps, u, day);
  if (deliveries.length) {
    const packs = deliveries.reduce((s2, o) => s2 + o.items.reduce((x, i) => x + i.qtyCans / i.packSize, 0), 0);
    const total = deliveries.reduce((s2, o) => s2 + o.total, 0);
    parts.push(`\n🚚 <b>Bugun yetkazish: ${deliveries.length} ta</b> (${Math.round(packs)} blok${u.role !== 'DRIVER' ? ', ' + formatMoney(total) : ''})`);
    parts.push(...deliveries.slice(0, 12).map((o) => deliveryLine(o, u.role !== 'DRIVER')));
    if (deliveries.length > 12) parts.push(`… va yana ${deliveries.length - 12} ta`);
    buttons.push([{ text: '🗺 Marshrut', app: 'route' }]);
    for (const o of deliveries.slice(0, 3)) buttons.push([{ text: `✅ Yetkazildi: ${o.shop.name}`.slice(0, 60), app: `d_${o.id}` }]);
  }

  {
    // Money to collect today: deliveries today + invoices due today (drivers see only this amount)
    const due = await deps.db.order.findMany({
      where: { status: 'DELIVERED', dueDate: toDbDate(day), ...orderFilter(u) },
      include: { shop: true },
    });
    const dueSum = due.reduce((x, o) => x + outstanding(o), 0);
    const deliverySum = deliveries.reduce((x, o) => x + o.total, 0);
    if (dueSum + deliverySum > 0) {
      parts.push(`\n💰 <b>Bugun yig'iladigan pul: ${formatMoney(dueSum + deliverySum)}</b>`);
      if (dueSum) parts.push(`   muddati bugun: ${formatMoney(dueSum)} (${due.filter((o) => outstanding(o) > 0).length} ta hujjat)`);
    }
  }

  if (u.role !== 'DRIVER') {
    const shops = await deps.db.shop.findMany({ where: { archivedAt: null, ...shopFilter(u) }, include: { district: true } });
    const bal = await shopBalances(deps.db, day, shops.map((x) => x.id));
    const overdue = shops.map((x) => ({ shop: x, b: bal.get(x.id)! })).filter((x) => x.b.overdue > 0).sort((a, b) => b.b.overdue - a.b.overdue);
    if (overdue.length) {
      const sum = overdue.reduce((x, o) => x + o.b.overdue, 0);
      parts.push(`\n⚠️ <b>Muddati o'tgan qarz: ${formatMoney(sum)}</b> (${overdue.length} ta do'kon)`);
      parts.push(...overdue.slice(0, 5).map((o) => `• ${esc(o.shop.name)} — ${formatMoney(o.b.overdue)}`));
      buttons.push([{ text: '📋 Qarzdorlar', app: 'debtors' }]);
    }
    // Shops to visit: today's route day, or visit frequency passed
    const wd = weekday(day);
    const lastVisits = await deps.db.visit.groupBy({ by: ['shopId'], where: { shopId: { in: shops.map((x) => x.id) } }, _max: { visitedAt: true } });
    const lv = new Map(lastVisits.map((v) => [v.shopId, v._max.visitedAt]));
    const toVisit = shops.filter((x) => {
      if (x.status === 'INACTIVE') return false;
      if (x.district?.routeDay === wd) return true;
      const last = lv.get(x.id);
      return !!x.visitEveryDays && (!last || daysBetween(localDate(last), day) >= x.visitEveryDays);
    });
    if (toVisit.length) {
      parts.push(`\n📍 <b>Tashrif: ${toVisit.length} ta do'kon</b>`);
      parts.push(esc(toVisit.slice(0, 8).map((x) => x.name).join(', ')) + (toVisit.length > 8 ? ' …' : ''));
    }
  }

  if (u.role !== 'AGENT') {
    // Stock warnings
    const products = await deps.db.product.findMany({ where: { archivedAt: null } });
    const levels = await stockLevels(deps.db, products.map((p) => p.id));
    const low = products.filter((p) => levels.get(p.id)!.available < s.lowStockPacks * p.packSize);
    if (low.length) {
      parts.push(`\n📦 <b>Kam qoldi:</b> ${esc(low.map((p) => `${p.flavour} (${formatQty(levels.get(p.id)!.available, p.packSize)})`).join(', '))}`);
    }
    const expUntil = addDays(day, s.expiryWarnDays);
    const exp = await deps.db.stockBatch.findMany({
      where: { remainingCans: { gt: 0 }, expiry: { lte: toDbDate(expUntil) } },
      include: { product: true },
      orderBy: { expiry: 'asc' },
      take: 6,
    });
    if (exp.length) {
      parts.push(`\n⏳ <b>Muddati yaqin:</b> ${esc(exp.map((b) => `${b.product.flavour} ${formatQty(b.remainingCans, b.product.packSize)} — ${fromDbDate(b.expiry)}`).join('; '))}`);
    }
  }

  const reminders = await deps.db.reminder.count({ where: { userId: u.id, doneAt: null, dueDate: { lte: toDbDate(day) }, OR: [{ snoozedTo: null }, { snoozedTo: { lte: toDbDate(day) } }] } });
  if (reminders) parts.push(`\n🔔 Eslatmalar: ${reminders} ta`);

  if (parts.length === 1) parts.push("\nBugun rejada hech narsa yo'q. Yaxshi kun! 🙂");
  return { text: parts.join('\n'), buttons };
}

/** 20:00 — tomorrow's deliveries and what to order from Tashkent. */
export async function eveningDigest(deps: Deps, s: Settings, u: Recipient, day: string, proposal: { packs: number; lines: { flavour: string; packs: number }[]; arrival: string } | null): Promise<Message | null> {
  const tomorrow = addDays(day, 1);
  const parts: string[] = [`🌙 <b>Ertaga, ${WEEKDAYS_UZ[weekday(tomorrow)]} ${formatDateHuman(tomorrow)}</b>`];
  const buttons: Button[][] = [];
  const deliveries = await deliveriesFor(deps, u, tomorrow);
  if (deliveries.length) {
    const packs = deliveries.reduce((x, o) => x + o.items.reduce((y, i) => y + i.qtyCans / i.packSize, 0), 0);
    parts.push(`\n🚚 <b>Yetkazish: ${deliveries.length} ta</b> (${Math.round(packs)} blok${u.role !== 'DRIVER' ? ', ' + formatMoney(deliveries.reduce((x, o) => x + o.total, 0)) : ''})`);
    parts.push(...deliveries.slice(0, 12).map((o) => deliveryLine(o, u.role !== 'DRIVER')));
    buttons.push([{ text: 'Buyurtmalar', app: 'today' }]);
  } else parts.push("\nErtaga yetkazish yo'q.");
  if (u.role === 'OWNER' && proposal && proposal.packs > 0) {
    parts.push(`\n📦 <b>Toshkentga buyurtma kerak: ${proposal.packs} blok</b> (${formatDateHuman(proposal.arrival)} ga)`);
    parts.push(esc(proposal.lines.filter((l) => l.packs > 0).map((l) => `${l.flavour} ${l.packs}`).join(', ')));
    buttons.push([{ text: '📦 Toshkentga buyurtma', app: 'tashkent' }]);
  }
  return { text: parts.join('\n'), buttons };
}

export function cutoffMessage(arrival: string, cutoff: string, packs: number): Message {
  return {
    text: `⏰ <b>${WEEKDAYS_UZ[weekday(arrival)]} yetkazish uchun bugun ${cutoff} gacha Toshkentga buyurtma bering.</b>\nTaklif: ${packs} blok.`,
    buttons: [[{ text: '📦 Toshkentga buyurtma', app: 'tashkent' }]],
  };
}
