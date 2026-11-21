import type { App } from '../app.ts';
import { body, idParam, ok } from '../app.ts';
import { isOwner, requireRole } from '../../core/permissions.ts';
import { forbidden, notFound } from '../../core/errors.ts';
import { audit } from '../../core/audit.ts';
import { fileUrl, saveFile } from '../../core/files.ts';
import { commissionStatement, dashboard } from '../../domain/reports.ts';
import { buildExport, toCsv, toXlsx, type ExportKind } from '../../reports/exports.ts';
import { formatDate, fromDbDate, localDate, toDbDate } from '../../shared/dates.ts';
import { parse, z, money, id, text, localDate as dateSchema } from '../validate.ts';

const range = (q: Record<string, string>, today: string) => ({
  from: /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from : today.slice(0, 8) + '01',
  to: /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to : today,
});

export function reportRoutes(app: App) {
  app.get('/api/dashboard', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const { from, to } = range(c.req.query(), localDate(ctx.now()));
    return ok(c, await dashboard(ctx, from, to));
  });

  /** Commission statement. Agents see only their own. */
  app.get('/api/commission', async (c) => {
    const ctx = c.get('ctx');
    const userId = Number(c.req.query('userId')) || ctx.user.id;
    if (userId !== ctx.user.id && !isOwner(ctx.user)) throw forbidden();
    const month = c.req.query('month') ?? localDate(ctx.now()).slice(0, 7);
    return ok(c, await commissionStatement(ctx, userId, month));
  });

  // ── Expenses ──
  app.get('/api/expense-categories', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    return ok(c, { categories: await ctx.db.expenseCategory.findMany({ where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } }) });
  });

  app.post('/api/expense-categories', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const { name } = parse(z.object({ name: text(60).min(1) }), await body(c));
    const k = await ctx.db.expenseCategory.create({ data: { name, sortOrder: await ctx.db.expenseCategory.count() } });
    return ok(c, { id: k.id });
  });

  app.get('/api/expenses', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const { from, to } = range(c.req.query(), localDate(ctx.now()));
    const list = await ctx.db.expense.findMany({
      where: { voidedAt: null, date: { gte: toDbDate(from), lte: toDbDate(to) } },
      include: { category: true },
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
    });
    return ok(c, {
      from,
      to,
      total: list.reduce((s, e) => s + e.amount, 0),
      expenses: list.map((e) => ({ id: e.id, categoryId: e.categoryId, category: e.category.name, amount: e.amount, date: fromDbDate(e.date), comment: e.comment, receiptUrl: fileUrl(e.receiptFileId), receiptFileId: e.receiptFileId })),
    });
  });

  const expenseInput = z.object({ categoryId: id, amount: money.min(1), date: dateSchema, comment: text(300).nullable().optional(), receiptFileId: id.nullable().optional() });

  app.post('/api/expenses', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const input = parse(expenseInput, await body(c));
    const e = await ctx.db.expense.create({ data: { ...input, date: toDbDate(input.date), createdById: ctx.user.id } });
    await audit(ctx.db, ctx.user.id, 'expense.create', 'expense', e.id, undefined, input);
    return ok(c, { id: e.id });
  });

  app.patch('/api/expenses/:id', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const eid = idParam(c);
    const input = parse(expenseInput.partial(), await body(c));
    const before = await ctx.db.expense.findUnique({ where: { id: eid } });
    if (!before) throw notFound();
    await ctx.db.expense.update({ where: { id: eid }, data: { ...input, date: input.date ? toDbDate(input.date) : undefined } });
    await audit(ctx.db, ctx.user.id, 'expense.update', 'expense', eid, before, input);
    return ok(c, { ok: true });
  });

  app.post('/api/expenses/:id/void', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const eid = idParam(c);
    await ctx.db.expense.update({ where: { id: eid }, data: { voidedAt: ctx.now() } });
    await audit(ctx.db, ctx.user.id, 'expense.void', 'expense', eid);
    return ok(c, { ok: true });
  });

  // ── Exports: Excel / CSV sent to my chat ──
  app.post('/api/exports', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const today = localDate(ctx.now());
    const input = parse(
      z.object({ kind: z.enum(['sales', 'debts', 'stock', 'payments', 'expenses', 'supplier']), format: z.enum(['xlsx', 'csv']), from: dateSchema.optional(), to: dateSchema.optional() }),
      await body(c),
    );
    const from = input.from ?? today.slice(0, 8) + '01';
    const to = input.to ?? today;
    const table = await buildExport(ctx, input.kind as ExportKind, from, to);
    const period = input.kind === 'debts' || input.kind === 'stock' ? `${formatDate(today)} holatiga` : `${formatDate(from)} — ${formatDate(to)}`;
    const data = input.format === 'xlsx' ? await toXlsx(table, { business: ctx.settings.businessName, period }) : toCsv(table);
    const name = `${table.title.replace(/[^\p{L}\d]+/gu, '-')}-${input.kind === 'debts' || input.kind === 'stock' ? today : `${from}_${to}`}.${input.format}`;
    const file = await saveFile(ctx.db, ctx.blobs, {
      kind: 'EXPORT',
      name,
      contentType: input.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
      data,
      userId: ctx.user.id,
    });
    await ctx.notifier.sendDocument(ctx.user.telegramId, { name, data }, `📊 ${table.title} · ${period} · ${table.rows.length} qator`);
    return ok(c, { fileId: file.id, rows: table.rows.length });
  });
}
