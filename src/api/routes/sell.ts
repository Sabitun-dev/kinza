import type { App } from '../app.ts';
import { body, ok } from '../app.ts';
import { assertOrderAccess, assertShopAccess, requireRole } from '../../core/permissions.ts';
import { noSale, preorder, sell, sellForm } from '../../domain/sell.ts';
import { parse, z, money, id, text, localDate as dateSchema } from '../validate.ts';

const line = z.object({ productId: id, qtyCans: z.number().int().min(1).max(1_000_000), pricePerPack: money.optional(), pricePerCan: money.optional(), isBonus: z.boolean().optional() });
const pos = z.object({ lat: z.number(), lng: z.number() }).nullable().optional();
const payment = z.object({ amount: money, method: z.enum(['CASH', 'CARD', 'TRANSFER']) }).nullable().optional();
const key = z.string().min(8).max(80);

/** "Sotish": van sale at the shop (order + delivery in one step). */
export function sellRoutes(app: App) {
  app.get('/api/sell-form', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const shopId = Number(c.req.query('shopId'));
    await assertShopAccess(ctx, shopId);
    const orderId = Number(c.req.query('orderId')) || undefined;
    return ok(c, await sellForm(ctx, shopId, orderId));
  });

  app.post('/api/sell', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const input = parse(
      z.object({
        shopId: id,
        orderId: id.nullable().optional(),
        lines: z.array(line).min(1).max(100),
        discount: money.optional(),
        comment: text(500).nullable().optional(),
        payment,
        returns: z.array(z.object({ productId: id, qtyCans: z.number().int().min(1), condition: z.enum(['SELLABLE', 'DAMAGED', 'EXPIRED']) })).optional(),
        returnReason: text(200).nullable().optional(),
        idempotencyKey: key,
        pos,
        force: z.boolean().optional(),
      }),
      await body(c),
    );
    await assertShopAccess(ctx, input.shopId);
    if (input.orderId) await assertOrderAccess(ctx, input.orderId);
    return ok(c, await sell(ctx, input));
  });

  app.post('/api/sell/no-order', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const input = parse(z.object({ shopId: id, kind: z.enum(['NO_ORDER', 'CLOSED']), reason: text(200).nullable(), payment, idempotencyKey: key, pos }), await body(c));
    await assertShopAccess(ctx, input.shopId);
    return ok(c, await noSale(ctx, input));
  });

  app.post('/api/sell/preorder', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const input = parse(
      z.object({ shopId: id, lines: z.array(line).min(1).max(100), discount: money.optional(), comment: text(500).nullable().optional(), deliveryDate: dateSchema.optional(), idempotencyKey: key, force: z.boolean().optional(), pos }),
      await body(c),
    );
    await assertShopAccess(ctx, input.shopId);
    return ok(c, await preorder(ctx, input));
  });
}
