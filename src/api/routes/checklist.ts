import type { App } from '../app.ts';
import { body, idParam, ok } from '../app.ts';
import { requireRole } from '../../core/permissions.ts';
import { notFound } from '../../core/errors.ts';
import { inTx } from '../../core/db.ts';
import { closeDay, coverage, ensureChecklist, isDayOff, markNoVisitOutcome, moveItem, nextWorkingDay, shopsWithProblems } from '../../checklist/checklist.ts';
import { checklistView } from '../../checklist/view.ts';
import { bizInfo, sendDocumentToChat, storeDocument } from '../../domain/docs.ts';
import { checklistDocument } from '../../pdf/documents.ts';
import { addDays, fromDbDate, localDate, toDbDate, weekday } from '../../shared/dates.ts';
import { parse, z, text, localDate as dateSchema } from '../validate.ts';

const pos = z.object({ lat: z.number(), lng: z.number() }).nullable().optional();

export function checklistRoutes(app: App) {
  /** Today's (or a given day's) checklist — created on first open if the scheduler has not yet. */
  app.get('/api/checklist', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const today = localDate(ctx.now());
    const date = c.req.query('date') ?? today;
    const problems = await shopsWithProblems(ctx.db, ctx.user);
    if (await isDayOff(ctx.db, ctx.settings, date)) {
      return ok(c, { dayOff: true, date, nextWorkingDay: await nextWorkingDay(ctx.db, ctx.settings, date), problems });
    }
    const list = date <= today ? await ensureChecklist(ctx.db, ctx.settings, ctx.user, date) : await ctx.db.checklist.findUnique({ where: { userId_date: { userId: ctx.user.id, date: toDbDate(date) } } });
    if (!list) return ok(c, { dayOff: false, date, notCreated: true, problems });
    return ok(c, { ...(await checklistView(ctx.db, ctx.settings, list, ctx.user.id)), problems });
  });

  app.post('/api/checklist/items/:id/no-order', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(z.object({ reason: text(200).min(1), pos }), await body(c));
    return ok(c, await markNoVisitOutcome(ctx, idParam(c), 'NO_ORDER', input.reason, input.pos));
  });

  app.post('/api/checklist/items/:id/closed', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(z.object({ pos }), await body(c));
    return ok(c, await markNoVisitOutcome(ctx, idParam(c), 'CLOSED', 'Yopiq edi', input.pos));
  });

  app.post('/api/checklist/items/:id/move', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(z.object({ date: dateSchema, reason: text(200).min(1) }), await body(c));
    return ok(c, await moveItem(ctx, idParam(c), input.date, input.reason));
  });

  app.post('/api/checklist/:id/close', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(z.object({ decisions: z.array(z.object({ itemId: z.number().int(), choice: z.enum(['tomorrow', 'friday', 'nextweek', 'visited']) })).default([]) }), await body(c));
    return ok(c, await closeDay(ctx, idParam(c), input.decisions));
  });

  /** "Bugungi ro'yxat" PDF in route order, sent to my chat. */
  app.post('/api/checklist/:id/print', async (c) => {
    const ctx = c.get('ctx');
    const list = await ctx.db.checklist.findUnique({ where: { id: idParam(c) } });
    if (!list || (list.userId !== ctx.user.id && ctx.user.role !== 'OWNER')) throw notFound();
    const view = await checklistView(ctx.db, ctx.settings, list, ctx.user.id);
    const docId = await inTx(ctx.db, async (tx) => {
      const bytes = await checklistDocument({
        date: view.date,
        business: await bizInfo(tx, ctx.blobs, ctx.settings),
        title: `BUGUNGI RO'YXAT${view.areas.length ? ' · ' + view.areas.join(', ') : ''}`,
        plannedKm: view.plannedKm,
        rows: view.items
          .filter((i) => i.status !== 'MOVED')
          .map((i, k) => ({
            no: k + 1,
            name: i.shop.name,
            address: i.shop.address ?? '',
            phone: i.shop.phones[0] ?? '',
            debt: i.balance,
            note: i.source === 'CARRY' ? 'Kecha qolgan' : i.source === 'PREORDER' ? 'Oldindan buyurtma' : i.source === 'NEW' ? 'Yangi' : '',
          })),
      });
      const d = await storeDocument(tx, ctx, { kind: 'CHECKLIST', bytes, fileName: `Royxat-${view.date}.pdf` });
      return d.id;
    });
    await sendDocumentToChat(ctx, docId, ctx.user.telegramId, `📋 Bugungi ro'yxat · ${view.total} ta do'kon`);
    return ok(c, { ok: true });
  });

  /** Weekly coverage: % of due shops visited and every shop that was missed. */
  app.get('/api/coverage', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const today = localDate(ctx.now());
    const monday = addDays(today, 1 - weekday(today));
    const from = c.req.query('from') ?? monday;
    const to = c.req.query('to') ?? today;
    return ok(c, await coverage(ctx.db, ctx.user, from, to, today));
  });

  // ── Days off ──
  app.get('/api/holidays', async (c) => {
    const ctx = c.get('ctx');
    const list = await ctx.db.holiday.findMany({ where: { date: { gte: toDbDate(addDays(localDate(ctx.now()), -30)) } }, orderBy: { date: 'asc' } });
    return ok(c, { holidays: list.map((h) => ({ date: fromDbDate(h.date), note: h.note })) });
  });

  app.post('/api/holidays', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const input = parse(z.object({ date: dateSchema, note: text(100).nullable().optional() }), await body(c));
    await ctx.db.holiday.upsert({ where: { date: toDbDate(input.date) }, create: { date: toDbDate(input.date), note: input.note ?? null }, update: { note: input.note ?? null } });
    return ok(c, { ok: true });
  });

  app.post('/api/holidays/:date/delete', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    await ctx.db.holiday.deleteMany({ where: { date: toDbDate(c.req.param('date')) } });
    return ok(c, { ok: true });
  });
}
