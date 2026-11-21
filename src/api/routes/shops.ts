import type { App } from '../app.ts';
import { body, idParam, ok } from '../app.ts';
import { assertShopAccess, isOwner, requireRole, shopScope } from '../../core/permissions.ts';
import { bad, notFound } from '../../core/errors.ts';
import { audit } from '../../core/audit.ts';
import { fileUrl } from '../../core/files.ts';
import { inTx } from '../../core/db.ts';
import { nextNumber, formatDocNumber } from '../../core/counters.ts';
import { outstanding, payStatus, reallocateShop, shopBalances } from '../../domain/ledger.ts';
import { localDate, fromDbDate, toDbDate, localDateTime, addDays } from '../../shared/dates.ts';
import { defaultCanPrice } from '../../shared/qty.ts';
import { parse, z, money, id, text, localDate as dateSchema } from '../validate.ts';
import type { Prisma } from '../../generated/prisma/client.ts';

const shopInput = z.object({
  name: text(120).min(1),
  contactName: text(120).nullable().optional(),
  phones: z.array(text(30)).max(5).optional(),
  address: text(300).nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  districtId: id.nullable().optional(),
  priceGroupId: id.nullable().optional(),
  paymentDays: z.number().int().min(0).max(365).nullable().optional(),
  creditLimit: money.nullable().optional(),
  visitEveryDays: z.number().int().min(1).max(90).nullable().optional(),
  noOrderAlertDays: z.number().int().min(1).max(365).nullable().optional(),
  status: z.enum(['LEAD', 'SAMPLE', 'ORDERED', 'REGULAR', 'INACTIVE']).optional(),
  agentId: id.nullable().optional(),
  notes: text(2000).nullable().optional(),
  photoFileId: id.nullable().optional(),
  legalName: text(200).nullable().optional(),
  stir: text(20).nullable().optional(),
  bankName: text(120).nullable().optional(),
  mfo: text(10).nullable().optional(),
  bankAccount: text(30).nullable().optional(),
});

/** Fields an agent may not change (business decisions stay with the owner). */
const OWNER_ONLY_FIELDS = ['priceGroupId', 'paymentDays', 'creditLimit', 'agentId', 'noOrderAlertDays'] as const;

function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function shopRoutes(app: App) {
  app.get('/api/shops', async (c) => {
    const ctx = c.get('ctx');
    const q = (c.req.query('q') ?? '').trim();
    const lat = Number(c.req.query('lat'));
    const lng = Number(c.req.query('lng'));
    const status = c.req.query('status');
    const districtId = Number(c.req.query('districtId')) || undefined;
    const archived = c.req.query('archived') === '1';
    const where: Prisma.ShopWhereInput = {
      ...shopScope(ctx.user),
      archivedAt: archived ? { not: null } : null,
      ...(status ? { status: status as never } : {}),
      ...(districtId ? { districtId } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { contactName: { contains: q, mode: 'insensitive' } },
              { address: { contains: q, mode: 'insensitive' } },
              { phones: { has: q } },
            ],
          }
        : {}),
    };
    const shops = await ctx.db.shop.findMany({
      where,
      include: { district: true, agent: { select: { name: true } }, priceGroup: { select: { name: true } } },
      take: 500,
    });
    const ids = shops.map((s) => s.id);
    const today = localDate(ctx.now());
    const [balances, lastOrders, myRecent] = await Promise.all([
      shopBalances(ctx.db, today, ids),
      ctx.db.order.groupBy({ by: ['shopId'], where: { shopId: { in: ids }, isOpening: false, status: { not: 'CANCELLED' } }, _max: { createdAt: true } }),
      ctx.db.order.groupBy({ by: ['shopId'], where: { shopId: { in: ids }, agentId: ctx.user.id }, _max: { createdAt: true } }),
    ]);
    const lastOrder = new Map(lastOrders.map((o) => [o.shopId, o._max.createdAt]));
    const recent = new Map(myRecent.map((o) => [o.shopId, o._max.createdAt?.getTime() ?? 0]));
    const hasGps = Number.isFinite(lat) && Number.isFinite(lng) && !!c.req.query('lat');
    const list = shops.map((s) => {
      const b = balances.get(s.id)!;
      return {
        id: s.id,
        name: s.name,
        contactName: s.contactName,
        phones: s.phones,
        address: s.address,
        lat: s.lat,
        lng: s.lng,
        status: s.status,
        district: s.district ? { id: s.district.id, name: s.district.name, routeDay: s.district.routeDay } : null,
        agentName: s.agent?.name ?? null,
        priceGroup: s.priceGroup?.name ?? null,
        balance: b.balance,
        overdue: b.overdue,
        creditLimit: s.creditLimit,
        lastOrderAt: lastOrder.get(s.id) ?? null,
        photoUrl: fileUrl(s.photoFileId, 7 * 86400),
        distanceKm: hasGps && s.lat != null && s.lng != null ? Math.round(distanceKm(lat, lng, s.lat, s.lng) * 100) / 100 : null,
        recent: recent.get(s.id) ?? 0,
      };
    });
    list.sort((a, b) => {
      if (hasGps) {
        if (a.distanceKm != null && b.distanceKm != null) return a.distanceKm - b.distanceKm;
        if (a.distanceKm != null) return -1;
        if (b.distanceKm != null) return 1;
      }
      return b.recent - a.recent || a.name.localeCompare(b.name);
    });
    return ok(c, { shops: list });
  });

  app.get('/api/shops/:id', async (c) => {
    const ctx = c.get('ctx');
    const sid = idParam(c);
    await assertShopAccess(ctx, sid);
    const today = localDate(ctx.now());
    const shop = await ctx.db.shop.findUnique({
      where: { id: sid },
      include: {
        district: true,
        priceGroup: true,
        agent: { select: { id: true, name: true } },
        shopPrices: { where: { archivedAt: null }, include: { product: true } },
      },
    });
    if (!shop) throw notFound();
    const [balance, orders, payments, lastVisit, nextDelivery, favourites, stats, documents] = await Promise.all([
      shopBalances(ctx.db, today, [sid]).then((m) => m.get(sid)!),
      ctx.db.order.findMany({ where: { shopId: sid }, orderBy: { createdAt: 'desc' }, take: 20, include: { _count: { select: { items: true } } } }),
      ctx.db.payment.findMany({ where: { shopId: sid, voidedAt: null }, orderBy: { paidAt: 'desc' }, take: 20, include: { receivedBy: { select: { name: true } } } }),
      ctx.db.visit.findFirst({ where: { shopId: sid }, orderBy: { visitedAt: 'desc' } }),
      ctx.db.order.findFirst({ where: { shopId: sid, status: { in: ['CONFIRMED', 'IN_TRANSIT'] } }, orderBy: { deliveryDate: 'asc' } }),
      ctx.db.orderItem.groupBy({
        by: ['productId'],
        where: { order: { shopId: sid, status: 'DELIVERED' }, isBonus: false },
        _sum: { qtyCans: true },
        orderBy: { _sum: { qtyCans: 'desc' } },
        take: 3,
      }),
      ctx.db.order.aggregate({ where: { shopId: sid, status: 'DELIVERED', isOpening: false }, _sum: { total: true }, _count: true }),
      ctx.db.document.findMany({ where: { OR: [{ shopId: sid }, { order: { shopId: sid } }] }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    const products = await ctx.db.product.findMany({ where: { id: { in: favourites.map((f) => f.productId) } } });
    const pmap = new Map(products.map((p) => [p.id, p]));
    const lastOrder = orders.find((o) => !o.isOpening && o.status !== 'CANCELLED');
    const total = stats._sum.total ?? 0;
    return ok(c, {
      shop: {
        ...shop,
        photoUrl: fileUrl(shop.photoFileId, 7 * 86400),
        shopPrices: undefined,
        agent: shop.agent,
        district: shop.district,
        priceGroup: shop.priceGroup ? { id: shop.priceGroup.id, name: shop.priceGroup.name } : null,
        paymentDaysEffective: shop.paymentDays ?? ctx.settings.paymentDays,
      },
      balance,
      creditLeft: shop.creditLimit != null ? shop.creditLimit - balance.balance : null,
      stats: {
        totalBought: total,
        orderCount: stats._count,
        avgOrder: stats._count ? Math.round(total / stats._count) : 0,
        lastOrderAt: lastOrder?.createdAt ?? null,
        lastVisit: lastVisit ? { at: lastVisit.visitedAt, result: lastVisit.result, note: lastVisit.note } : null,
        nextDelivery: nextDelivery ? { id: nextDelivery.id, date: fromDbDate(nextDelivery.deliveryDate), number: nextDelivery.number } : null,
        favourites: favourites.map((f) => ({ productId: f.productId, flavour: pmap.get(f.productId)?.flavour ?? '', cans: f._sum.qtyCans ?? 0, packSize: pmap.get(f.productId)?.packSize ?? 24 })),
      },
      orders: orders.map((o) => ({
        id: o.id,
        number: o.number,
        status: o.status,
        isOpening: o.isOpening,
        deliveryDate: fromDbDate(o.deliveryDate),
        total: o.total,
        outstanding: o.status === 'DELIVERED' ? outstanding(o) : 0,
        payStatus: payStatus(o, today),
        createdAt: o.createdAt,
      })),
      payments: payments.map((p) => ({ id: p.id, amount: p.amount, method: p.method, paidAt: p.paidAt, receivedBy: p.receivedBy.name, comment: p.comment })),
      specialPrices: isOwner(ctx.user) || ctx.user.role === 'AGENT'
        ? shop.shopPrices.map((sp) => ({ productId: sp.productId, flavour: sp.product.flavour, perPack: sp.perPack, perCan: sp.perCan }))
        : [],
      documents: documents.map((d) => ({ id: d.id, kind: d.kind, number: d.number, revision: d.revision, voided: !!d.voidedAt, createdAt: d.createdAt })),
    });
  });

  app.post('/api/shops', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const input = parse(shopInput, await body(c));
    if (!isOwner(ctx.user)) for (const k of OWNER_ONLY_FIELDS) delete (input as Record<string, unknown>)[k];
    const shop = await ctx.db.shop.create({
      data: {
        ...input,
        phones: (input.phones ?? []).filter(Boolean),
        status: input.status ?? 'LEAD',
        agentId: isOwner(ctx.user) ? (input.agentId ?? null) : ctx.user.id,
        createdById: ctx.user.id,
      },
    });
    await audit(ctx.db, ctx.user.id, 'shop.create', 'shop', shop.id, undefined, shop);
    return ok(c, { id: shop.id });
  });

  app.patch('/api/shops/:id', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const sid = idParam(c);
    await assertShopAccess(ctx, sid);
    const input = parse(shopInput.partial(), await body(c));
    if (!isOwner(ctx.user)) for (const k of OWNER_ONLY_FIELDS) delete (input as Record<string, unknown>)[k];
    const before = await ctx.db.shop.findUniqueOrThrow({ where: { id: sid } });
    const after = await ctx.db.shop.update({
      where: { id: sid },
      data: { ...input, phones: input.phones ? input.phones.filter(Boolean) : undefined },
    });
    await audit(ctx.db, ctx.user.id, 'shop.update', 'shop', sid, before, after);
    return ok(c, { ok: true });
  });

  app.post('/api/shops/:id/archive', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const sid = idParam(c);
    const { archived } = parse(z.object({ archived: z.boolean() }), await body(c));
    await ctx.db.shop.update({ where: { id: sid }, data: { archivedAt: archived ? new Date() : null } });
    await audit(ctx.db, ctx.user.id, archived ? 'shop.archive' : 'shop.restore', 'shop', sid);
    return ok(c, { ok: true });
  });

  /** Special prices for one shop. perPack null removes the special price. */
  app.put('/api/shops/:id/prices', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const sid = idParam(c);
    const { prices } = parse(
      z.object({ prices: z.array(z.object({ productId: id, perPack: money.nullable(), perCan: money.optional() })) }),
      await body(c),
    );
    await inTx(ctx.db, async (tx) => {
      for (const p of prices) {
        const current = await tx.shopPrice.findFirst({ where: { shopId: sid, productId: p.productId, archivedAt: null } });
        const product = await tx.product.findUniqueOrThrow({ where: { id: p.productId } });
        const perCan = p.perPack == null ? null : (p.perCan ?? defaultCanPrice(p.perPack, product.packSize));
        if (current && p.perPack === current.perPack && perCan === current.perCan) continue;
        if (current) await tx.shopPrice.update({ where: { id: current.id }, data: { archivedAt: new Date() } });
        if (p.perPack != null) {
          await tx.shopPrice.create({ data: { shopId: sid, productId: p.productId, perPack: p.perPack, perCan: perCan!, createdById: ctx.user.id } });
        }
        await audit(tx, ctx.user.id, 'shopPrice.change', 'shop', sid, current ? { productId: p.productId, perPack: current.perPack, perCan: current.perCan } : null, p.perPack == null ? null : { productId: p.productId, perPack: p.perPack, perCan });
      }
    });
    return ok(c, { ok: true });
  });

  /** Debt from before the app. Stored as a delivered "opening" document so payments apply to it. */
  app.post('/api/shops/:id/opening-balance', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const sid = idParam(c);
    const input = parse(z.object({ amount: money.min(1), date: dateSchema.optional(), comment: text(300).optional() }), await body(c));
    const date = input.date ?? localDate(ctx.now());
    const shop = await ctx.db.shop.findUnique({ where: { id: sid } });
    if (!shop) throw notFound();
    if (date > localDate(ctx.now())) throw bad("Sana kelajakda bo'lmasin");
    const order = await inTx(ctx.db, async (tx) => {
      const year = Number(date.slice(0, 4));
      const n = await nextNumber(tx, 'OPENING', year);
      const deliveredAt = localDateTime(date, '00:00');
      const o = await tx.order.create({
        data: {
          number: formatDocNumber('QOLDIQ', year, n, ctx.settings.numberDigits),
          shopId: sid,
          agentId: ctx.user.id,
          status: 'DELIVERED',
          isOpening: true,
          deliveryDate: toDbDate(date),
          deliveredAt,
          dueDate: toDbDate(addDays(date, shop.paymentDays ?? ctx.settings.paymentDays)),
          subtotal: input.amount,
          total: input.amount,
          comment: input.comment ?? "Boshlang'ich qarz",
        },
      });
      await audit(tx, ctx.user.id, 'shop.openingBalance', 'shop', sid, undefined, { orderId: o.id, amount: input.amount, date });
      await reallocateShop(tx, sid);
      return o;
    });
    return ok(c, { orderId: order.id });
  });
}
