import type { App } from '../app.ts';
import { body, idParam, ok } from '../app.ts';
import { assertShopAccess, isOwner } from '../../core/permissions.ts';
import { forbidden, notFound } from '../../core/errors.ts';
import { addDays, fromDbDate, localDate, toDbDate } from '../../shared/dates.ts';
import { parse, z, id, text, localDate as dateSchema } from '../validate.ts';

export function reminderRoutes(app: App) {
  app.get('/api/reminders', async (c) => {
    const ctx = c.get('ctx');
    const all = c.req.query('all') === '1' && isOwner(ctx.user);
    const list = await ctx.db.reminder.findMany({
      where: { ...(all ? {} : { userId: ctx.user.id }), doneAt: c.req.query('done') === '1' ? { not: null } : null },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 200,
      include: { shop: { select: { id: true, name: true } }, user: { select: { name: true } } },
    });
    const today = localDate(ctx.now());
    return ok(c, {
      reminders: list.map((r) => {
        const due = fromDbDate(r.snoozedTo && r.snoozedTo > r.dueDate ? r.snoozedTo : r.dueDate)!;
        return { id: r.id, note: r.note, dueDate: due, overdue: due < today, shop: r.shop, orderId: r.orderId, userName: r.user.name, done: !!r.doneAt };
      }),
    });
  });

  app.post('/api/reminders', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(z.object({ note: text(500).min(1), dueDate: dateSchema, shopId: id.nullable().optional(), orderId: id.nullable().optional(), userId: id.optional() }), await body(c));
    if (input.shopId) await assertShopAccess(ctx, input.shopId);
    if (input.userId && input.userId !== ctx.user.id && !isOwner(ctx.user)) throw forbidden();
    const r = await ctx.db.reminder.create({
      data: { note: input.note, dueDate: toDbDate(input.dueDate), shopId: input.shopId ?? null, orderId: input.orderId ?? null, userId: input.userId ?? ctx.user.id, createdById: ctx.user.id },
    });
    return ok(c, { id: r.id });
  });

  app.post('/api/reminders/:id/done', async (c) => {
    const ctx = c.get('ctx');
    const r = await ctx.db.reminder.updateMany({ where: { id: idParam(c), ...(isOwner(ctx.user) ? {} : { userId: ctx.user.id }) }, data: { doneAt: ctx.now() } });
    if (!r.count) throw notFound();
    return ok(c, { ok: true });
  });

  app.post('/api/reminders/:id/reopen', async (c) => {
    const ctx = c.get('ctx');
    const r = await ctx.db.reminder.updateMany({ where: { id: idParam(c), ...(isOwner(ctx.user) ? {} : { userId: ctx.user.id }) }, data: { doneAt: null } });
    if (!r.count) throw notFound();
    return ok(c, { ok: true });
  });

  app.post('/api/reminders/:id/snooze', async (c) => {
    const ctx = c.get('ctx');
    const { days } = parse(z.object({ days: z.number().int().min(1).max(60).default(1) }), await body(c));
    const r = await ctx.db.reminder.updateMany({
      where: { id: idParam(c), ...(isOwner(ctx.user) ? {} : { userId: ctx.user.id }) },
      data: { snoozedTo: toDbDate(addDays(localDate(ctx.now()), days)) },
    });
    if (!r.count) throw notFound();
    return ok(c, { ok: true });
  });
}
