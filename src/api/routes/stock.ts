import type { App } from '../app.ts';
import { body, ok } from '../app.ts';
import { assertShopAccess, requireRole } from '../../core/permissions.ts';
import { adjustStock, batchesReport, saveStockCount } from '../../domain/stockOps.ts';
import { stockLevels } from '../../domain/stockLevels.ts';
import { parse, z, money, id, text, localDate as dateSchema } from '../validate.ts';

export function stockRoutes(app: App) {
  /** Stock movements of one product (newest first). */
  app.get('/api/stock/movements', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'DRIVER');
    const productId = Number(c.req.query('productId')) || undefined;
    const moves = await ctx.db.stockMovement.findMany({
      where: productId ? { productId } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const shopIds = [...new Set(moves.map((m) => m.shopId).filter((x): x is number => !!x))];
    const shops = await ctx.db.shop.findMany({ where: { id: { in: shopIds } }, select: { id: true, name: true } });
    const name = new Map(shops.map((s) => [s.id, s.name]));
    return ok(c, {
      movements: moves.map((m) => ({
        id: m.id,
        productId: m.productId,
        type: m.type,
        pool: m.pool,
        qtyCans: m.qtyCans,
        costPerCan: m.costPerCan,
        reason: m.reason,
        shopName: m.shopId ? name.get(m.shopId) : null,
        orderId: m.orderId,
        createdAt: m.createdAt,
      })),
    });
  });

  app.get('/api/stock/batches', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'DRIVER');
    return ok(c, { batches: await batchesReport(ctx) });
  });

  app.post('/api/stock/adjust', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(
      z.object({
        productId: id,
        type: z.enum(['SAMPLE_OUT', 'DAMAGE', 'EXPIRED', 'WRITE_OFF']),
        qtyCans: z.number().int().min(1),
        shopId: id.nullable().optional(),
        reason: text(300).nullable().optional(),
        fromPool: z.enum(['SELLABLE', 'DAMAGED']).optional(),
      }),
      await body(c),
    );
    if (input.shopId) await assertShopAccess(ctx, input.shopId);
    return ok(c, await adjustStock(ctx, input));
  });

  app.get('/api/stock-counts', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const counts = await ctx.db.stockCount.findMany({ orderBy: { createdAt: 'desc' }, take: 30, include: { items: { include: { product: { select: { flavour: true, packSize: true } } } } } });
    return ok(c, {
      counts: counts.map((k) => ({
        id: k.id,
        note: k.note,
        createdAt: k.createdAt,
        items: k.items.map((i) => ({ flavour: i.product.flavour, packSize: i.product.packSize, expectedCans: i.expectedCans, countedCans: i.countedCans, diff: i.countedCans - i.expectedCans })),
      })),
    });
  });

  app.get('/api/stock-counts/sheet', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const products = await ctx.db.product.findMany({ where: { archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { flavour: 'asc' }] });
    const levels = await stockLevels(ctx.db, products.map((p) => p.id));
    return ok(c, { items: products.map((p) => ({ productId: p.id, flavour: p.flavour, packSize: p.packSize, expectedCans: levels.get(p.id)!.inStock, buyPricePerPack: p.buyPricePerPack })) });
  });

  app.post('/api/stock-counts', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(
      z.object({
        note: text(300).nullable().optional(),
        items: z.array(z.object({ productId: id, countedCans: z.number().int().min(0), costPerPack: money.nullable().optional(), expiry: dateSchema.nullable().optional() })).min(1),
      }),
      await body(c),
    );
    return ok(c, await saveStockCount(ctx, input));
  });
}
