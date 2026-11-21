import type { App } from '../app.ts';
import { body, idParam, ok } from '../app.ts';
import { assertShopAccess, isOwner, requireRole, shopScope } from '../../core/permissions.ts';
import { confirmHandover, cashInHands, createPayment, createReconciliation, createReturn, debtors, reconciliationData, voidPayment } from '../../domain/payments.ts';
import { localDate, startOfLocalDay, addDays } from '../../shared/dates.ts';
import { parse, z, money, id, text, localDate as dateSchema } from '../validate.ts';
import type { Prisma } from '../../generated/prisma/client.ts';

export function paymentRoutes(app: App) {
  app.get('/api/payments', async (c) => {
    const ctx = c.get('ctx');
    const q = c.req.query();
    const where: Prisma.PaymentWhereInput = { voidedAt: q.voided === '1' ? { not: null } : null };
    if (ctx.user.role === 'AGENT') where.shop = shopScope(ctx.user);
    if (ctx.user.role === 'DRIVER') where.receivedById = ctx.user.id;
    if (q.shopId) where.shopId = Number(q.shopId);
    if (q.userId && isOwner(ctx.user)) where.receivedById = Number(q.userId);
    if (q.from || q.to) where.paidAt = { ...(q.from ? { gte: startOfLocalDay(q.from) } : {}), ...(q.to ? { lt: startOfLocalDay(addDays(q.to, 1)) } : {}) };
    const pays = await ctx.db.payment.findMany({
      where,
      orderBy: { paidAt: 'desc' },
      take: Math.min(Number(q.limit) || 200, 1000),
      include: { shop: { select: { id: true, name: true } }, receivedBy: { select: { name: true } }, targetOrder: { select: { number: true } } },
    });
    return ok(c, {
      payments: pays.map((p) => ({
        id: p.id,
        shop: p.shop,
        amount: p.amount,
        method: p.method,
        paidAt: p.paidAt,
        receivedBy: p.receivedBy.name,
        orderNumber: p.targetOrder?.number ?? null,
        comment: p.comment,
        inHands: !p.handedOverAt,
        voided: !!p.voidedAt,
        voidReason: p.voidReason,
      })),
      total: pays.reduce((s, p) => s + p.amount, 0),
    });
  });

  app.post('/api/payments', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(
      z.object({
        shopId: id,
        amount: money.min(1),
        method: z.enum(['CASH', 'CARD', 'TRANSFER']),
        date: dateSchema.optional(),
        targetOrderId: id.nullable().optional(),
        comment: text(300).nullable().optional(),
        idempotencyKey: z.string().min(8).max(80).optional(),
      }),
      await body(c),
    );
    await assertShopAccess(ctx, input.shopId);
    return ok(c, await createPayment(ctx, input));
  });

  app.post('/api/payments/:id/void', async (c) => {
    const ctx = c.get('ctx');
    const { reason } = parse(z.object({ reason: text(300).min(1) }), await body(c));
    await voidPayment(ctx, idParam(c), reason);
    return ok(c, { ok: true });
  });

  app.get('/api/debtors', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const r = await debtors(ctx, shopScope(ctx.user));
    const sort = c.req.query('sort') === 'age' ? 'age' : 'amount';
    r.rows.sort((a, b) => (sort === 'age' ? b.ageDays - a.ageDays : b.balance - a.balance));
    return ok(c, r);
  });

  app.get('/api/cash', async (c) => ok(c, await cashInHands(c.get('ctx'))));

  app.post('/api/cash/handover', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(z.object({ userId: id, paymentIds: z.array(id).optional(), note: text(200).optional() }), await body(c));
    return ok(c, await confirmHandover(ctx, input.userId, input.paymentIds, input.note));
  });

  app.get('/api/returns', async (c) => {
    const ctx = c.get('ctx');
    const shopId = Number(c.req.query('shopId')) || undefined;
    const rets = await ctx.db.return.findMany({
      where: { shop: shopScope(ctx.user), ...(shopId ? { shopId } : {}) },
      orderBy: { date: 'desc' },
      take: 200,
      include: { shop: { select: { id: true, name: true } }, items: { include: { product: { select: { flavour: true, packSize: true } } } } },
    });
    return ok(c, {
      returns: rets.map((r) => ({
        id: r.id,
        number: r.number,
        shop: r.shop,
        date: r.date,
        total: r.total,
        reason: r.reason,
        voided: !!r.voidedAt,
        items: r.items.map((i) => ({ flavour: i.product.flavour, packSize: i.product.packSize, qtyCans: i.qtyCans, condition: i.condition, lineTotal: i.lineTotal })),
      })),
    });
  });

  app.post('/api/returns', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(
      z.object({
        shopId: id,
        orderId: id.nullable().optional(),
        date: dateSchema.optional(),
        reason: text(300).nullable().optional(),
        lines: z
          .array(z.object({ productId: id, qtyCans: z.number().int().min(1), condition: z.enum(['SELLABLE', 'DAMAGED', 'EXPIRED']), pricePerCan: money.optional() }))
          .min(1),
      }),
      await body(c),
    );
    await assertShopAccess(ctx, input.shopId);
    return ok(c, await createReturn(ctx, input));
  });

  app.get('/api/shops/:id/reconciliation', async (c) => {
    const ctx = c.get('ctx');
    const sid = idParam(c);
    await assertShopAccess(ctx, sid);
    const to = c.req.query('to') ?? localDate(ctx.now());
    const from = c.req.query('from') ?? to.slice(0, 8) + '01';
    return ok(c, { from, to, ...(await reconciliationData(ctx, sid, from, to)) });
  });

  app.post('/api/shops/:id/reconciliation', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const sid = idParam(c);
    await assertShopAccess(ctx, sid);
    const { from, to } = parse(z.object({ from: dateSchema, to: dateSchema }), await body(c));
    return ok(c, await createReconciliation(ctx, sid, from, to));
  });
}
