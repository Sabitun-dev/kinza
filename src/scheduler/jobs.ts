import type { Deps, Ctx } from '../core/context.ts';
import type { Settings } from '../core/settings.ts';
import type { Message } from '../reminders/digests.ts';
import { cutoffMessage, eveningDigest, morningDigest } from '../reminders/digests.ts';
import { buildProposal } from '../domain/supplier.ts';
import { shopBalances } from '../domain/ledger.ts';
import { esc } from '../core/notifier.ts';
import { addDays, daysBetween, localDate, toDbDate, fromDbDate, startOfLocalDay } from '../shared/dates.ts';
import { formatMoney } from '../shared/money.ts';
import type { Job } from './run.ts';
import { claimOnce } from './once.ts';
import { autoCarryOver, ensureChecklist } from '../checklist/checklist.ts';
import { cleanupGps } from '../routing/drive.ts';

type U = { id: number; telegramId: bigint; role: 'OWNER' | 'AGENT' | 'DRIVER'; name: string };

/** Sends a message at most once per person, kind and day. A failed send can be retried later. */
export async function sendOnce(deps: Deps, u: U, kind: string, refKey: string, day: string, msg: Message | null) {
  if (!msg) return false;
  if (!(await claimOnce(deps, u.id, kind, refKey, day))) return false;
  try {
    await deps.notifier.sendMessage(Number(u.telegramId), msg.text, msg.buttons);
    return true;
  } catch (err) {
    await deps.db.notificationSent.deleteMany({ where: { userId: u.id, kind, refKey, day } });
    console.error('send failed', kind, u.id, err);
    return false;
  }
}

const activeUsers = (deps: Deps) => deps.db.user.findMany({ where: { active: true } }) as Promise<U[]>;

function systemCtx(deps: Deps, s: Settings, owner: U): Ctx {
  return { db: deps.db, settings: s, blobs: deps.blobs, notifier: deps.notifier, now: deps.now, user: { id: owner.id, telegramId: Number(owner.telegramId), name: owner.name, role: 'OWNER', active: true } };
}

async function proposalSummary(deps: Deps, s: Settings, owner: U) {
  const p = await buildProposal(systemCtx(deps, s, owner));
  return { packs: p.totals.packs, arrival: p.arrivalDate, lines: p.lines.map((l) => ({ flavour: l.flavour, packs: l.proposedPacks })) };
}

const morning: Job = {
  name: 'morning',
  at: (s) => s.morningDigestTime,
  run: async (deps, s, day) => {
    let n = 0;
    for (const u of await activeUsers(deps)) if (await sendOnce(deps, u, 'morning', '', day, await morningDigest(deps, s, u, day))) n++;
    return `${n} sent`;
  },
};

const evening: Job = {
  name: 'evening',
  at: (s) => s.eveningDigestTime,
  run: async (deps, s, day) => {
    let n = 0;
    for (const u of await activeUsers(deps)) {
      const proposal = u.role === 'OWNER' ? await proposalSummary(deps, s, u) : null;
      if (await sendOnce(deps, u, 'evening', '', day, await eveningDigest(deps, s, u, day, proposal))) n++;
    }
    return `${n} sent`;
  },
};

/** "Payshanba yetkazish uchun bugun 18:00 gacha Toshkentga buyurtma bering." */
const cutoff: Job = {
  name: 'cutoff',
  at: (s) => s.cutoffReminderTime,
  run: async (deps, s, day) => {
    const owners = (await activeUsers(deps)).filter((u) => u.role === 'OWNER');
    if (!owners.length) return 'no owner';
    const orderedToday = await deps.db.supplierOrder.count({ where: { createdAt: { gte: startOfLocalDay(day) }, status: { not: 'CANCELLED' } } });
    if (orderedToday) return 'already ordered';
    const p = await proposalSummary(deps, s, owners[0]);
    if (p.packs <= 0) return 'nothing to order';
    for (const o of owners) await sendOnce(deps, o, 'cutoff', '', day, cutoffMessage(p.arrival, s.supplierCutoffTime, p.packs));
    return `${p.packs} packs`;
  },
};

/** Overdue payments, "not ordered for N days", and custom reminders. */
const alerts: Job = {
  name: 'alerts',
  at: (s) => s.morningDigestTime,
  run: async (deps, s, day) => {
    const users = await activeUsers(deps);
    const owners = users.filter((u) => u.role === 'OWNER');
    const byId = new Map(users.map((u) => [u.id, u]));
    let sent = 0;

    const shops = await deps.db.shop.findMany({ where: { archivedAt: null, status: { not: 'INACTIVE' } } });
    const bal = await shopBalances(deps.db, day, shops.map((x) => x.id));
    const recipients = (agentId: number | null) => [...owners, ...(agentId && byId.get(agentId)?.role === 'AGENT' ? [byId.get(agentId)!] : [])];

    // Overdue per shop (largest 5 per day; the rest is in the morning digest)
    const overdue = shops.filter((x) => bal.get(x.id)!.overdue > 0).sort((a, b) => bal.get(b.id)!.overdue - bal.get(a.id)!.overdue).slice(0, 5);
    for (const shop of overdue) {
      const b = bal.get(shop.id)!;
      const msg: Message = {
        text: `⚠️ <b>${esc(shop.name)}</b>: muddati o'tgan qarz ${formatMoney(b.overdue)} (jami ${formatMoney(b.balance)}, ${b.oldestUnpaid ? daysBetween(b.oldestUnpaid, day) : 0} kun)`,
        buttons: [
          [{ text: 'Ochish', app: `s_${shop.id}` }, { text: "💰 To'lov kiritish", app: `p_${shop.id}` }],
          [{ text: '⏰ Kechiktirish', data: `sz:overdue:${shop.id}` }],
        ],
      };
      for (const u of recipients(shop.agentId)) if (await sendOnce(deps, u, 'overdue', String(shop.id), day, msg)) sent++;
    }

    // Not ordered for N days (regular customers only), at most once a week per shop
    const last = await deps.db.order.groupBy({ by: ['shopId'], where: { isOpening: false, status: { not: 'CANCELLED' } }, _max: { createdAt: true } });
    const lastMap = new Map(last.map((l) => [l.shopId, l._max.createdAt]));
    for (const shop of shops.filter((x) => x.status === 'REGULAR' || x.status === 'ORDERED')) {
      const lastAt = lastMap.get(shop.id);
      if (!lastAt) continue;
      const days = daysBetween(localDate(lastAt), day);
      if (days < (shop.noOrderAlertDays ?? s.noOrderAlertDays)) continue;
      const recent = await deps.db.notificationSent.count({ where: { kind: 'noorder', refKey: String(shop.id), day: { gte: addDays(day, -6) } } });
      if (recent) continue;
      const msg: Message = {
        text: `🛒 <b>${esc(shop.name)}</b> ${days} kundan beri buyurtma bermadi.`,
        buttons: [[{ text: 'Ochish', app: `s_${shop.id}` }], [{ text: '⏰ Kechiktirish', data: `sz:noorder:${shop.id}` }]],
      };
      for (const u of recipients(shop.agentId)) if (await sendOnce(deps, u, 'noorder', String(shop.id), day, msg)) sent++;
    }

    // Custom reminders due today (each person only their own)
    const due = await deps.db.reminder.findMany({
      where: { doneAt: null, dueDate: { lte: toDbDate(day) }, OR: [{ snoozedTo: null }, { snoozedTo: { lte: toDbDate(day) } }] },
      include: { shop: true },
    });
    for (const r of due) {
      const u = byId.get(r.userId);
      if (!u) continue;
      const open = r.orderId ? `o_${r.orderId}` : r.shopId ? `s_${r.shopId}` : 'reminders';
      const msg: Message = {
        text: `🔔 <b>Eslatma</b>${r.shop ? ` · ${esc(r.shop.name)}` : ''}\n${esc(r.note)}${fromDbDate(r.dueDate)! < day ? `\n(muddat: ${fromDbDate(r.dueDate)})` : ''}`,
        buttons: [
          [{ text: 'Ochish', app: open }, { text: '✅ Bajarildi', data: `rdone:${r.id}` }],
          [{ text: '⏰ Kechiktirish (1 kun)', data: `snz:${r.id}` }],
        ],
      };
      if (await sendOnce(deps, u, 'reminder', String(r.id), day, msg)) sent++;
    }
    return `${sent} alerts`;
  },
};

/** Early morning: today's checklist is created and stored for every owner and agent. */
const checklists: Job = {
  name: 'checklists',
  at: (s) => s.checklistCreateTime,
  run: async (deps, s, day) => {
    let n = 0;
    for (const u of await activeUsers(deps)) {
      if (u.role === 'DRIVER') continue;
      if (await ensureChecklist(deps.db, s, u, day)) n++;
    }
    return `${n} checklists`;
  },
};

/** 23:00: every ⏳ shop moves to the next working day. */
const carryOver: Job = {
  name: 'carryover',
  at: (s) => s.carryOverTime,
  run: async (deps, s, day) => `${await autoCarryOver(deps.db, s, day)} carried`,
};

/** GPS points are kept 30 days. */
const gpsCleanup: Job = {
  name: 'gpscleanup',
  at: (s) => s.backupTime,
  run: async (deps) => String(await cleanupGps(deps.db, deps.now())),
};

export const scheduledJobs: Job[] = [checklists, morning, alerts, cutoff, evening, carryOver, gpsCleanup];
