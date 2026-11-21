import type { App } from '../app.ts';
import { body, idParam, ok } from '../app.ts';
import { requireRole, isOwner } from '../../core/permissions.ts';
import { notFound } from '../../core/errors.ts';
import { audit } from '../../core/audit.ts';
import { fileUrl } from '../../core/files.ts';
import { currentPriceTable, pricesForShop } from '../../domain/pricing.ts';
import { stockLevels } from '../../domain/stockLevels.ts';
import { assertShopAccess } from '../../core/permissions.ts';
import { defaultCanPrice } from '../../shared/qty.ts';
import { parse, z, money, id, text } from '../validate.ts';
import type { Ctx } from '../../core/context.ts';

const priceInput = z.object({ perPack: money, perCan: money.optional() });

const productInput = z.object({
  name: text(60).min(1).default('Kinza'),
  flavour: text(60).min(1),
  packSize: z.number().int().min(1).max(200).optional(),
  buyPricePerPack: money.default(0),
  minPricePerPack: money.default(0),
  minPricePerCan: money.optional(),
  barcode: text(40).nullable().optional(),
  photoFileId: id.nullable().optional(),
  sortOrder: z.number().int().optional(),
  price: priceInput.optional(),
  groupPrices: z.array(z.object({ groupId: id, perPack: money.nullable(), perCan: money.optional() })).optional(),
});

/** Writes new price rows only where the price actually changed (keeps a clean history). */
async function savePrices(
  ctx: Ctx,
  productId: number,
  packSize: number,
  def: { perPack: number; perCan?: number } | undefined,
  groups: { groupId: number; perPack: number | null; perCan?: number }[] | undefined,
) {
  const table = await currentPriceTable(ctx.db);
  const wanted: { groupId: number | null; perPack: number; perCan: number }[] = [];
  if (def) wanted.push({ groupId: null, perPack: def.perPack, perCan: def.perCan ?? defaultCanPrice(def.perPack, packSize) });
  for (const g of groups ?? []) {
    if (g.perPack == null) continue;
    wanted.push({ groupId: g.groupId, perPack: g.perPack, perCan: g.perCan ?? defaultCanPrice(g.perPack, packSize) });
  }
  for (const w of wanted) {
    const cur = table.get(`${productId}:${w.groupId ?? 'default'}`);
    if (cur && cur.perPack === w.perPack && cur.perCan === w.perCan) continue;
    await ctx.db.productPrice.create({
      data: { productId, priceGroupId: w.groupId, perPack: w.perPack, perCan: w.perCan, changedById: ctx.user.id },
    });
    await audit(ctx.db, ctx.user.id, 'price.change', 'product', productId, cur ? { perPack: cur.perPack, perCan: cur.perCan, groupId: w.groupId } : null, w);
  }
}

export function productRoutes(app: App) {
  app.get('/api/products', async (c) => {
    const ctx = c.get('ctx');
    const showArchived = c.req.query('archived') === '1' && isOwner(ctx.user);
    const products = await ctx.db.product.findMany({
      where: showArchived ? {} : { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { flavour: 'asc' }],
    });
    const [table, levels, groups] = await Promise.all([
      currentPriceTable(ctx.db),
      stockLevels(ctx.db, products.map((p) => p.id)),
      ctx.db.priceGroup.findMany({ where: { archivedAt: null }, orderBy: { sortOrder: 'asc' } }),
    ]);
    const lowCans = (packSize: number) => ctx.settings.lowStockPacks * packSize;
    return ok(c, {
      products: products.map((p) => {
        const def = table.get(`${p.id}:default`);
        const l = levels.get(p.id)!;
        return {
          id: p.id,
          name: p.name,
          flavour: p.flavour,
          packSize: p.packSize,
          barcode: p.barcode,
          photoUrl: fileUrl(p.photoFileId, 7 * 86400),
          photoFileId: p.photoFileId,
          archived: !!p.archivedAt,
          sortOrder: p.sortOrder,
          buyPricePerPack: p.buyPricePerPack,
          minPricePerPack: p.minPricePerPack,
          minPricePerCan: p.minPricePerCan,
          prices: {
            perPack: def?.perPack ?? 0,
            perCan: def?.perCan ?? 0,
            groups: Object.fromEntries(groups.map((g) => [g.id, table.get(`${p.id}:${g.id}`) ?? null])),
          },
          stock: {
            inStock: l.inStock,
            reserved: l.reserved,
            available: l.available,
            damaged: l.damaged,
            nearestExpiry: l.nearestExpiry,
            stockValue: l.stockValue,
            low: l.available < lowCans(p.packSize),
          },
        };
      }),
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
    });
  });

  app.get('/api/products/:id', async (c) => {
    const ctx = c.get('ctx');
    const pid = idParam(c);
    const p = await ctx.db.product.findUnique({ where: { id: pid } });
    if (!p) throw notFound();
    const history = isOwner(ctx.user)
      ? await ctx.db.productPrice.findMany({ where: { productId: pid }, orderBy: { validFrom: 'desc' }, take: 50, include: { priceGroup: true } })
      : [];
    const users = await ctx.db.user.findMany({ select: { id: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.name]));
    const level = (await stockLevels(ctx.db, [pid])).get(pid)!;
    return ok(c, {
      product: { ...p, photoUrl: fileUrl(p.photoFileId, 7 * 86400) },
      stock: level,
      priceHistory: history.map((h) => ({
        id: h.id,
        group: h.priceGroup?.name ?? 'Asosiy',
        perPack: h.perPack,
        perCan: h.perCan,
        validFrom: h.validFrom,
        changedBy: h.changedById ? name.get(h.changedById) : null,
      })),
    });
  });

  app.post('/api/products', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const input = parse(productInput, await body(c));
    const packSize = input.packSize ?? ctx.settings.defaultPackSize;
    const p = await ctx.db.product.create({
      data: {
        name: input.name,
        flavour: input.flavour,
        packSize,
        buyPricePerPack: input.buyPricePerPack,
        minPricePerPack: input.minPricePerPack,
        minPricePerCan: input.minPricePerCan ?? defaultCanPrice(input.minPricePerPack, packSize),
        barcode: input.barcode || null,
        photoFileId: input.photoFileId ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });
    await audit(ctx.db, ctx.user.id, 'product.create', 'product', p.id, undefined, p);
    await savePrices(ctx, p.id, packSize, input.price, input.groupPrices);
    return ok(c, { id: p.id });
  });

  app.patch('/api/products/:id', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const pid = idParam(c);
    const input = parse(productInput.partial(), await body(c));
    const before = await ctx.db.product.findUnique({ where: { id: pid } });
    if (!before) throw notFound();
    const packSize = input.packSize ?? before.packSize;
    const after = await ctx.db.product.update({
      where: { id: pid },
      data: {
        name: input.name,
        flavour: input.flavour,
        packSize: input.packSize,
        buyPricePerPack: input.buyPricePerPack,
        minPricePerPack: input.minPricePerPack,
        minPricePerCan:
          input.minPricePerCan ?? (input.minPricePerPack != null ? defaultCanPrice(input.minPricePerPack, packSize) : undefined),
        barcode: input.barcode === undefined ? undefined : input.barcode || null,
        photoFileId: input.photoFileId,
        sortOrder: input.sortOrder,
      },
    });
    await audit(ctx.db, ctx.user.id, 'product.update', 'product', pid, before, after);
    await savePrices(ctx, pid, packSize, input.price, input.groupPrices);
    return ok(c, { ok: true });
  });

  app.post('/api/products/:id/archive', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const pid = idParam(c);
    const { archived } = parse(z.object({ archived: z.boolean() }), await body(c));
    await ctx.db.product.update({ where: { id: pid }, data: { archivedAt: archived ? new Date() : null } });
    await audit(ctx.db, ctx.user.id, archived ? 'product.archive' : 'product.restore', 'product', pid);
    return ok(c, { ok: true });
  });

  /** Prices that apply to one shop (used by the order screen). */
  app.get('/api/pricing', async (c) => {
    const ctx = c.get('ctx');
    const shopId = Number(c.req.query('shopId')) || null;
    if (shopId) await assertShopAccess(ctx, shopId);
    const prices = await pricesForShop(ctx.db, shopId);
    return ok(c, { prices: Object.fromEntries(prices), maxDiscountBp: isOwner(ctx.user) ? null : ctx.settings.agentMaxDiscountBp });
  });

  // ── Price groups ──
  app.get('/api/price-groups', async (c) => {
    const ctx = c.get('ctx');
    const groups = await ctx.db.priceGroup.findMany({ orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }], include: { _count: { select: { shops: true } } } });
    return ok(c, { groups: groups.map((g) => ({ id: g.id, name: g.name, archived: !!g.archivedAt, shops: g._count.shops })) });
  });

  app.post('/api/price-groups', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const { name } = parse(z.object({ name: text(60).min(1) }), await body(c));
    const count = await ctx.db.priceGroup.count();
    const g = await ctx.db.priceGroup.create({ data: { name, sortOrder: count } });
    await audit(ctx.db, ctx.user.id, 'priceGroup.create', 'priceGroup', g.id, undefined, g);
    return ok(c, { id: g.id });
  });

  app.patch('/api/price-groups/:id', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const gid = idParam(c);
    const input = parse(z.object({ name: text(60).min(1).optional(), archived: z.boolean().optional() }), await body(c));
    await ctx.db.priceGroup.update({
      where: { id: gid },
      data: { name: input.name, archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null },
    });
    await audit(ctx.db, ctx.user.id, 'priceGroup.update', 'priceGroup', gid, undefined, input);
    return ok(c, { ok: true });
  });

  // ── Districts / route days ──
  app.get('/api/districts', async (c) => {
    const ctx = c.get('ctx');
    const list = await ctx.db.district.findMany({ where: { archivedAt: null }, orderBy: [{ routeDay: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] });
    return ok(c, { districts: list });
  });

  app.post('/api/districts', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const input = parse(z.object({ name: text(60).min(1), routeDay: z.number().int().min(1).max(7).nullable().optional() }), await body(c));
    const d = await ctx.db.district.create({ data: { name: input.name, routeDay: input.routeDay ?? null } });
    return ok(c, { id: d.id });
  });

  app.patch('/api/districts/:id', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const did = idParam(c);
    const input = parse(
      z.object({ name: text(60).min(1).optional(), routeDay: z.number().int().min(1).max(7).nullable().optional(), archived: z.boolean().optional() }),
      await body(c),
    );
    await ctx.db.district.update({
      where: { id: did },
      data: { name: input.name, routeDay: input.routeDay, archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null },
    });
    return ok(c, { ok: true });
  });
}
