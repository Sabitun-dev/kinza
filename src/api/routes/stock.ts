import type { App } from '../app.ts';
import { ok } from '../app.ts';
import { requireRole } from '../../core/permissions.ts';

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
}
