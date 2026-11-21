import type { App } from '../app.ts';
import { body, ok } from '../app.ts';
import { assertShopAccess, isOwner, requireRole, shopScope } from '../../core/permissions.ts';
import { inTx } from '../../core/db.ts';
import { audit } from '../../core/audit.ts';
import { itemForShop, setItemStatus } from '../../checklist/checklist.ts';
import { localDate, startOfLocalDay, addDays, toDbDate } from '../../shared/dates.ts';
import { parse, z, id, text, localDate as dateSchema } from '../validate.ts';
import type { ChecklistStatus } from '../../generated/prisma/enums.ts';

const STAGES = ['LEAD', 'SAMPLE', 'ORDERED', 'REGULAR'] as const;

/** Visits ("Tashrif" in 3 taps) and the leads pipeline. */
export function visitRoutes(app: App) {
  app.post('/api/visits', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const input = parse(
      z.object({
        shopId: id,
        result: z.enum(['ORDERED', 'THINKING', 'REFUSED', 'CLOSED', 'NO_ORDER']),
        note: text(500).nullable().optional(),
        followUpDate: dateSchema.nullable().optional(),
        lat: z.number().nullable().optional(),
        lng: z.number().nullable().optional(),
        idempotencyKey: z.string().min(8).max(80).optional(),
      }),
      await body(c),
    );
    await assertShopAccess(ctx, input.shopId);
    if (input.idempotencyKey) {
      const dup = await ctx.db.visit.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (dup) return ok(c, { id: dup.id, duplicate: true });
    }
    const today = localDate(ctx.now());
    const r = await inTx(ctx.db, async (tx) => {
      const v = await tx.visit.create({
        data: {
          shopId: input.shopId,
          userId: ctx.user.id,
          result: input.result,
          note: input.note || null,
          reason: input.note || null,
          lat: input.lat ?? null,
          lng: input.lng ?? null,
          followUpDate: input.followUpDate ? toDbDate(input.followUpDate) : null,
          idempotencyKey: input.idempotencyKey ?? null,
          visitedAt: ctx.now(),
        },
      });
      // A follow-up date creates a reminder
      if (input.followUpDate) {
        const shop = await tx.shop.findUniqueOrThrow({ where: { id: input.shopId } });
        await tx.reminder.create({
          data: { userId: ctx.user.id, shopId: input.shopId, visitId: v.id, note: input.note ? `${shop.name}: ${input.note}` : `${shop.name}: qayta tashrif`, dueDate: toDbDate(input.followUpDate), createdById: ctx.user.id },
        });
      }
      // The visit also marks today's checklist row (an order is marked by Sotish itself)
      const status: Record<string, ChecklistStatus | null> = { ORDERED: null, THINKING: 'NO_ORDER', REFUSED: 'NO_ORDER', NO_ORDER: 'NO_ORDER', CLOSED: 'CLOSED' };
      const st = status[input.result];
      if (st) {
        const item = await itemForShop(tx, ctx.settings, ctx.user, input.shopId, today);
        if (item && item.status === 'PENDING') await setItemStatus(tx, item.id, st, { reason: input.note ?? null, visitId: v.id, at: ctx.now() });
      }
      await audit(tx, ctx.user.id, 'visit.create', 'shop', input.shopId, undefined, { result: input.result, followUpDate: input.followUpDate });
      return v;
    });
    return ok(c, { id: r.id });
  });

  app.get('/api/visits', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const q = c.req.query();
    const from = q.from ?? addDays(localDate(ctx.now()), -6);
    const visits = await ctx.db.visit.findMany({
      where: {
        visitedAt: { gte: startOfLocalDay(from) },
        shop: shopScope(ctx.user),
        ...(q.shopId ? { shopId: Number(q.shopId) } : {}),
        ...(isOwner(ctx.user) ? (q.userId ? { userId: Number(q.userId) } : {}) : { userId: ctx.user.id }),
      },
      orderBy: { visitedAt: 'desc' },
      take: 300,
      include: { shop: { select: { id: true, name: true } }, user: { select: { name: true } } },
    });
    return ok(c, {
      visits: visits.map((v) => ({ id: v.id, shop: v.shop, result: v.result, note: v.note, at: v.visitedAt, by: v.user.name, lat: v.lat, lng: v.lng, followUpDate: v.followUpDate })),
    });
  });

  /** Kanban: Lead → Namuna berildi → Buyurtma qildi → Doimiy, with conversion rates. */
  app.get('/api/leads', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'AGENT');
    const shops = await ctx.db.shop.findMany({
      where: { ...shopScope(ctx.user), archivedAt: null, status: { in: [...STAGES] } },
      select: { id: true, name: true, status: true, address: true, createdAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    const columns = STAGES.map((st) => ({ status: st, shops: shops.filter((s) => s.status === st) }));
    const count = (i: number) => columns.slice(i).reduce((s, col) => s + col.shops.length, 0); // reached this stage or later
    const conversion = STAGES.slice(1).map((st, i) => ({ from: STAGES[i], to: st, percent: count(i) ? Math.round((count(i + 1) / count(i)) * 100) : 0 }));
    return ok(c, { columns, conversion });
  });
}
