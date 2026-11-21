import type { App } from '../app.ts';
import { body, ok } from '../app.ts';
import { requireRole } from '../../core/permissions.ts';
import { carStock, countCar, loadingProposal, moveCarStock } from '../../domain/van.ts';
import { parse, z, id, text, localDate as dateSchema } from '../validate.ts';

const lines = z.array(z.object({ productId: id, qtyCans: z.number().int().min(0).max(1_000_000) })).min(1);

/** My car ("Mashina"): stock, morning loading, unloading and the evening count. */
export function vanRoutes(app: App) {
  app.get('/api/car', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    return ok(c, { products: await carStock(ctx.db, ctx.user.id) });
  });

  app.get('/api/car/proposal', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const date = parse(dateSchema.optional(), c.req.query('date'));
    return ok(c, await loadingProposal(ctx, date));
  });

  app.post('/api/car/load', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const input = parse(z.object({ lines, note: text(200).nullable().optional() }), await body(c));
    return ok(c, await moveCarStock(ctx, true, input.lines, input.note));
  });

  app.post('/api/car/unload', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const input = parse(z.object({ lines, note: text(200).nullable().optional() }), await body(c));
    return ok(c, await moveCarStock(ctx, false, input.lines, input.note));
  });

  app.post('/api/car/count', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const input = parse(z.object({ items: z.array(z.object({ productId: id, countedCans: z.number().int().min(0) })).min(1), note: text(200).nullable().optional() }), await body(c));
    return ok(c, await countCar(ctx, input.items, input.note));
  });
}
