import type { Context } from 'hono';
import type { App, Env } from '../app.ts';
import { body, idParam, ok } from '../app.ts';
import { assertOrderAccess, assertShopAccess, isOwner, orderScope } from '../../core/permissions.ts';
import { forbidden, notFound } from '../../core/errors.ts';
import { fileUrl } from '../../core/files.ts';
import { publicFileUrl, sendDocumentToChat } from '../../domain/docs.ts';
import { assignDriver, cancelOrder, confirmOrder, createOrder, defaultDeliveryDate, deliverOrder, reviseOrder, shipOrder, updateOrder } from '../../domain/orders.ts';
import { outstanding, payStatus, shopBalances } from '../../domain/ledger.ts';
import { pricesForShop } from '../../domain/pricing.ts';
import { stockLevels } from '../../domain/stockLevels.ts';
import { fromDbDate, localDate, toDbDate } from '../../shared/dates.ts';
import { parse, z, money, id, text, localDate as dateSchema } from '../validate.ts';
import type { Prisma } from '../../generated/prisma/client.ts';
import { t } from '../../shared/i18n/index.ts';

const lineSchema = z.object({
  productId: id,
  qtyCans: z.number().int().min(1).max(1_000_000),
  pricePerPack: money.optional(),
  pricePerCan: money.optional(),
  isBonus: z.boolean().optional(),
});

const orderSchema = z.object({
  shopId: id,
  lines: z.array(lineSchema).min(1).max(100),
  discount: money.optional(),
  deliveryDate: dateSchema.optional(),
  comment: text(500).nullable().optional(),
  confirm: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(80).optional(),
  force: z.boolean().optional(),
  offline: z.boolean().optional(),
});

export function orderRoutes(app: App) {
  app.get('/api/orders', async (c) => {
    const ctx = c.get('ctx');
    const q = c.req.query();
    const today = localDate(ctx.now());
    const where: Prisma.OrderWhereInput = { ...orderScope(ctx.user), isOpening: false };
    if (q.status) where.status = { in: q.status.split(',') as never[] };
    if (q.date) where.deliveryDate = toDbDate(q.date);
    if (q.from || q.to) where.deliveryDate = { ...(q.from ? { gte: toDbDate(q.from) } : {}), ...(q.to ? { lte: toDbDate(q.to) } : {}) };
    if (q.shopId) where.shopId = Number(q.shopId);
    if (q.agentId && isOwner(ctx.user)) where.agentId = Number(q.agentId);
    if (q.q) where.OR = [{ number: { contains: q.q, mode: 'insensitive' } }, { shop: { name: { contains: q.q, mode: 'insensitive' } } }];
    if (q.unpaid === '1') where.status = 'DELIVERED';
    const orders = await ctx.db.order.findMany({
      where,
      orderBy: q.date || q.status?.includes('CONFIRMED') ? [{ deliveryDate: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }],
      take: Math.min(Number(q.limit) || 150, 500),
      include: {
        shop: { select: { id: true, name: true, address: true, lat: true, lng: true, phones: true } },
        agent: { select: { name: true } },
        driver: { select: { name: true } },
        items: { select: { qtyCans: true, packSize: true } },
      },
    });
    let list = orders.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      shop: o.shop,
      deliveryDate: fromDbDate(o.deliveryDate),
      total: o.total,
      packs: Math.round(o.items.reduce((s, i) => s + i.qtyCans / i.packSize, 0) * 10) / 10,
      payStatus: payStatus(o, today),
      outstanding: o.status === 'DELIVERED' ? outstanding(o) : 0,
      agentName: o.agent?.name ?? null,
      driverName: o.driver?.name ?? null,
      createdAt: o.createdAt,
      syncNote: o.syncNote,
    }));
    if (q.unpaid === '1') list = list.filter((o) => o.outstanding > 0);
    return ok(c, { orders: list });
  });

  /** Everything the order screen needs in one call. */
  app.get('/api/order-form', async (c) => {
    const ctx = c.get('ctx');
    const shopId = Number(c.req.query('shopId'));
    await assertShopAccess(ctx, shopId);
    const today = localDate(ctx.now());
    const [shop, products, prices, favourites, last, balance] = await Promise.all([
      ctx.db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { id: true, name: true, creditLimit: true, address: true, priceGroup: { select: { name: true } } } }),
      ctx.db.product.findMany({ where: { archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { flavour: 'asc' }] }),
      pricesForShop(ctx.db, shopId, ctx.now()),
      ctx.db.orderItem.groupBy({
        by: ['productId'],
        where: { order: { shopId, status: { not: 'CANCELLED' } }, isBonus: false },
        _sum: { qtyCans: true },
        orderBy: { _sum: { qtyCans: 'desc' } },
      }),
      ctx.db.order.findFirst({
        where: { shopId, status: { notIn: ['CANCELLED'] }, isOpening: false },
        orderBy: { createdAt: 'desc' },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      }),
      shopBalances(ctx.db, today, [shopId]).then((m) => m.get(shopId)!),
    ]);
    const levels = await stockLevels(ctx.db, products.map((p) => p.id));
    const favRank = new Map(favourites.map((f, i) => [f.productId, i]));
    const sorted = [...products].sort((a, b) => (favRank.get(a.id) ?? 999) - (favRank.get(b.id) ?? 999));
    return ok(c, {
      shop,
      balance,
      deliveryDate: defaultDeliveryDate(ctx),
      maxDiscountBp: isOwner(ctx.user) ? null : ctx.settings.agentMaxDiscountBp,
      products: sorted.map((p) => {
        const pr = prices.get(p.id)!;
        return {
          id: p.id,
          name: p.name,
          flavour: p.flavour,
          packSize: p.packSize,
          photoUrl: fileUrl(p.photoFileId, 7 * 86400),
          perPack: pr.perPack,
          perCan: pr.perCan,
          minPerPack: pr.minPerPack,
          minPerCan: pr.minPerCan,
          priceSource: pr.source,
          available: levels.get(p.id)!.available,
          favourite: favRank.has(p.id) && favRank.get(p.id)! < 5,
        };
      }),
      lastOrder: last
        ? { id: last.id, number: last.number, date: last.createdAt, lines: last.items.map((i) => ({ productId: i.productId, qtyCans: i.orderedCans, isBonus: i.isBonus })) }
        : null,
    });
  });

  app.get('/api/orders/:id', async (c) => {
    const ctx = c.get('ctx');
    const oid = idParam(c);
    await assertOrderAccess(ctx, oid);
    const today = localDate(ctx.now());
    const o = await ctx.db.order.findUniqueOrThrow({
      where: { id: oid },
      include: {
        shop: true,
        agent: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true } },
        items: { include: { product: true }, orderBy: { sortOrder: 'asc' } },
        documents: { orderBy: { createdAt: 'desc' } },
        allocations: { include: { payment: { include: { receivedBy: { select: { name: true } } } }, return: true } },
      },
    });
    const history = await ctx.db.auditLog.findMany({ where: { entity: 'order', entityId: String(oid) }, orderBy: { createdAt: 'asc' } });
    const users = await ctx.db.user.findMany({ select: { id: true, name: true } });
    const uname = new Map(users.map((u) => [u.id, u.name]));
    const balance = (await shopBalances(ctx.db, today, [o.shopId])).get(o.shopId)!;
    return ok(c, {
      order: {
        id: o.id,
        number: o.number,
        status: o.status,
        revision: o.revision,
        deliveryDate: fromDbDate(o.deliveryDate),
        dueDate: fromDbDate(o.dueDate),
        subtotal: o.subtotal,
        discount: o.discount,
        total: o.total,
        costTotal: o.costTotal,
        grossProfit: o.status === 'DELIVERED' ? o.total - o.costTotal : null,
        paidAmount: o.paidAmount,
        returnedAmount: o.returnedAmount,
        outstanding: o.status === 'DELIVERED' ? outstanding(o) : 0,
        payStatus: payStatus(o, today),
        comment: o.comment,
        syncNote: o.syncNote,
        cancelReason: o.cancelReason,
        createdAt: o.createdAt,
        confirmedAt: o.confirmedAt,
        deliveredAt: o.deliveredAt,
        agent: o.agent,
        driver: o.driver,
        deliveryPhotoUrl: fileUrl(o.deliveryPhotoFileId),
        shop: { id: o.shop.id, name: o.shop.name, address: o.shop.address, phones: o.shop.phones, lat: o.shop.lat, lng: o.shop.lng, balance: balance.balance },
        items: o.items.map((i) => ({
          id: i.id,
          productId: i.productId,
          flavour: i.product.flavour,
          name: i.product.name,
          photoUrl: fileUrl(i.product.photoFileId, 7 * 86400),
          packSize: i.packSize,
          orderedCans: i.orderedCans,
          qtyCans: i.qtyCans,
          pricePerPack: i.pricePerPack,
          pricePerCan: i.pricePerCan,
          basePerPack: i.basePerPack,
          isBonus: i.isBonus,
          lineTotal: i.lineTotal,
          costPerCan: i.costPerCan,
          costTotal: i.costTotal,
        })),
        documents: o.documents.map((d) => ({ id: d.id, kind: d.kind, number: d.number, revision: d.revision, voided: !!d.voidedAt, createdAt: d.createdAt })),
        payments: o.allocations.map((a) =>
          a.payment
            ? { kind: 'payment', id: a.payment.id, amount: a.amount, method: a.payment.method, at: a.payment.paidAt, by: a.payment.receivedBy.name }
            : { kind: 'return', id: a.return!.id, amount: a.amount, number: a.return!.number, at: a.return!.date },
        ),
        history: history.map((h) => ({ action: h.action, by: h.userId ? uname.get(h.userId) : null, at: h.createdAt, after: isOwner(ctx.user) ? h.after : undefined })),
      },
    });
  });

  app.post('/api/orders', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(orderSchema, await body(c));
    await assertShopAccess(ctx, input.shopId);
    return ok(c, await createOrder(ctx, input));
  });

  app.patch('/api/orders/:id', async (c) => {
    const ctx = c.get('ctx');
    const oid = idParam(c);
    await assertOrderAccess(ctx, oid);
    const input = parse(orderSchema.omit({ shopId: true, confirm: true }), await body(c));
    return ok(c, await updateOrder(ctx, oid, input));
  });

  app.post('/api/orders/:id/confirm', async (c) => {
    const ctx = c.get('ctx');
    const oid = idParam(c);
    await assertOrderAccess(ctx, oid);
    const { force } = parse(z.object({ force: z.boolean().optional() }), await body(c));
    return ok(c, await confirmOrder(ctx, oid, { force }));
  });

  app.post('/api/orders/:id/ship', async (c) => {
    const ctx = c.get('ctx');
    const oid = idParam(c);
    await assertOrderAccess(ctx, oid);
    const { driverId } = parse(z.object({ driverId: id.nullable().optional() }), await body(c));
    return ok(c, await shipOrder(ctx, oid, driverId));
  });

  app.post('/api/orders/:id/driver', async (c) => {
    const ctx = c.get('ctx');
    const { driverId } = parse(z.object({ driverId: id.nullable() }), await body(c));
    await assignDriver(ctx, idParam(c), driverId);
    return ok(c, { ok: true });
  });

  app.post('/api/orders/:id/deliver', async (c) => {
    const ctx = c.get('ctx');
    const oid = idParam(c);
    await assertOrderAccess(ctx, oid);
    const input = parse(
      z.object({
        items: z.array(z.object({ id, qtyCans: z.number().int().min(0) })).optional(),
        photoFileId: id.nullable().optional(),
        payment: z.object({ amount: money, method: z.enum(['CASH', 'CARD', 'TRANSFER']) }).nullable().optional(),
      }),
      await body(c),
    );
    return ok(c, await deliverOrder(ctx, oid, input));
  });

  app.post('/api/orders/:id/cancel', async (c) => {
    const ctx = c.get('ctx');
    const oid = idParam(c);
    await assertOrderAccess(ctx, oid);
    const { reason } = parse(z.object({ reason: text(300).min(1) }), await body(c));
    return ok(c, await cancelOrder(ctx, oid, reason));
  });

  app.post('/api/orders/:id/revise', async (c) => {
    const ctx = c.get('ctx');
    const oid = idParam(c);
    const input = parse(z.object({ lines: z.array(lineSchema).min(1), discount: money.optional(), reason: text(300).min(3) }), await body(c));
    return ok(c, await reviseOrder(ctx, oid, input));
  });

  // ── Documents ──
  async function docWithAccess(c: Context<Env>) {
    const ctx = c.get('ctx');
    const did = idParam(c);
    const doc = await ctx.db.document.findUnique({ where: { id: did }, include: { file: true, order: { select: { shopId: true } } } });
    if (!doc) throw notFound();
    if (doc.orderId) await assertOrderAccess(ctx, doc.orderId);
    else if (doc.shopId) await assertShopAccess(ctx, doc.shopId);
    else if (!isOwner(ctx.user)) throw forbidden();
    if (ctx.user.role === 'DRIVER' && doc.kind !== 'WAYBILL' && doc.kind !== 'PAYMENT_RECEIPT') throw forbidden();
    return doc;
  }

  app.post('/api/documents/:id/send', async (c) => {
    const ctx = c.get('ctx');
    const doc = await docWithAccess(c);
    const sent = await sendDocumentToChat(ctx, doc.id, ctx.user.telegramId, `${t(`docKind.${doc.kind}` as never)}${doc.number ? ' ' + doc.number : ''}${doc.voidedAt ? ' (bekor qilingan)' : ''}`);
    if (!sent) throw notFound('Faylni yuborib bo‘lmadi');
    return ok(c, { ok: true });
  });

  app.get('/api/documents/:id/link', async (c) => {
    const ctx = c.get('ctx');
    const doc = await docWithAccess(c);
    return ok(c, {
      url: publicFileUrl(ctx.settings, doc.fileId),
      title: `${ctx.settings.businessName}: ${t(`docKind.${doc.kind}` as never)}${doc.number ? ' ' + doc.number : ''}`,
    });
  });
}
