import type { App } from '../app.ts';
import { body, idParam, ok } from '../app.ts';
import { requireRole } from '../../core/permissions.ts';
import { notFound } from '../../core/errors.ts';
import { audit } from '../../core/audit.ts';
import {
  addSupplierPayment,
  buildProposal,
  createSupplierOrder,
  landedPerPack,
  receiveSupplierOrder,
  sendSupplierOrder,
  setSupplierStatus,
  supplierBalance,
  updateSupplierOrder,
} from '../../domain/supplier.ts';
import { fromDbDate } from '../../shared/dates.ts';
import { parse, z, money, id, text, localDate as dateSchema } from '../validate.ts';

const lines = z.array(z.object({ productId: id, orderedPacks: z.number().int().min(0).max(100_000), proposedPacks: z.number().int().min(0).optional(), buyPricePerPack: money.optional() }));

export function supplierRoutes(app: App) {
  app.get('/api/supplier/proposal', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    return ok(c, await buildProposal(ctx, c.req.query('coverUntil') || undefined));
  });

  app.get('/api/supplier-orders', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'DRIVER');
    const list = await ctx.db.supplierOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { items: true, costs: true, payments: { where: { voidedAt: null } } },
    });
    return ok(c, {
      orders: list.map((s) => ({
        id: s.id,
        number: s.number,
        status: s.status,
        arrivalDate: fromDbDate(s.arrivalDate),
        packs: s.items.reduce((x, i) => x + i.orderedPacks, 0),
        invoiceAmount: s.invoiceAmount ?? s.items.reduce((x, i) => x + i.orderedPacks * i.buyPricePerPack, 0),
        cost: s.costs.reduce((x, k) => x + k.amount, 0),
        createdAt: s.createdAt,
        receivedAt: s.receivedAt,
      })),
    });
  });

  app.get('/api/supplier-orders/:id', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER', 'DRIVER');
    const so = await ctx.db.supplierOrder.findUnique({
      where: { id: idParam(c) },
      include: { items: { include: { product: true } }, costs: true, payments: { where: { voidedAt: null } }, batches: true },
    });
    if (!so) throw notFound();
    const cargo = so.costs.reduce((s, k) => s + k.amount, 0);
    const arrivedPacks = so.items.reduce((s, i) => s + ((i.receivedCans ?? 0) + (i.damagedCans ?? 0)) / i.product.packSize, 0);
    return ok(c, {
      order: {
        id: so.id,
        number: so.number,
        status: so.status,
        arrivalDate: fromDbDate(so.arrivalDate),
        coverUntil: fromDbDate(so.coverUntil),
        comment: so.comment,
        orderedAt: so.orderedAt,
        receivedAt: so.receivedAt,
        invoiceAmount: so.invoiceAmount ?? so.items.reduce((x, i) => x + i.orderedPacks * i.buyPricePerPack, 0),
        cost: cargo,
        costs: so.costs.map((k) => ({ id: k.id, kind: k.kind, amount: k.amount, comment: k.comment })),
        payments: so.payments.map((p) => ({ id: p.id, amount: p.amount, paidAt: p.paidAt, method: p.method })),
        items: so.items.map((i) => ({
          id: i.id,
          productId: i.productId,
          flavour: i.product.flavour,
          packSize: i.product.packSize,
          proposedPacks: i.proposedPacks,
          orderedPacks: i.orderedPacks,
          buyPricePerPack: i.buyPricePerPack,
          receivedCans: i.receivedCans,
          damagedCans: i.damagedCans,
          expiry: fromDbDate(i.expiry),
          landedPerPack: so.status === 'RECEIVED' ? Math.round(landedPerPack(i.buyPricePerPack, cargo, arrivedPacks)) : null,
        })),
      },
    });
  });

  app.post('/api/supplier-orders', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(z.object({ lines, arrivalDate: dateSchema.optional(), coverUntil: dateSchema.optional(), comment: text(500).nullable().optional() }), await body(c));
    return ok(c, await createSupplierOrder(ctx, input));
  });

  app.patch('/api/supplier-orders/:id', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(z.object({ lines, arrivalDate: dateSchema.nullable().optional(), comment: text(500).nullable().optional() }), await body(c));
    await updateSupplierOrder(ctx, idParam(c), input);
    return ok(c, { ok: true });
  });

  app.post('/api/supplier-orders/:id/status', async (c) => {
    const ctx = c.get('ctx');
    const { status } = parse(z.object({ status: z.enum(['ORDERED', 'IN_TRANSIT', 'CANCELLED']) }), await body(c));
    await setSupplierStatus(ctx, idParam(c), status);
    return ok(c, { ok: true });
  });

  app.post('/api/supplier-orders/:id/send', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const { format } = parse(z.object({ format: z.enum(['text', 'pdf']) }), await body(c));
    return ok(c, await sendSupplierOrder(ctx, idParam(c), format));
  });

  app.post('/api/supplier-orders/:id/receive', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(
      z.object({
        lines: z.array(z.object({ itemId: id, receivedCans: z.number().int().min(0), damagedCans: z.number().int().min(0).optional(), expiry: dateSchema.nullable().optional(), buyPricePerPack: money.optional() })),
        cargoCost: money.optional(),
        invoiceAmount: money.nullable().optional(),
      }),
      await body(c),
    );
    return ok(c, await receiveSupplierOrder(ctx, idParam(c), input));
  });

  app.post('/api/supplier-orders/:id/costs', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const sid = idParam(c);
    const input = parse(z.object({ amount: money.min(1), kind: text(40).optional(), comment: text(200).optional() }), await body(c));
    // Costs added after receiving are kept for the record; they do not change the landed cost of stock already received.
    await ctx.db.supplierOrder.findUniqueOrThrow({ where: { id: sid } });
    const k =await ctx.db.shipmentCost.create({ data: { supplierOrderId: sid, amount: input.amount, kind: input.kind ?? 'cargo', comment: input.comment } });
    await audit(ctx.db, ctx.user.id, 'shipmentCost.create', 'supplierOrder', sid, undefined, input);
    return ok(c, { id: k.id });
  });

  app.patch('/api/supplier-orders/:id/invoice', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const sid = idParam(c);
    const { invoiceAmount } = parse(z.object({ invoiceAmount: money }), await body(c));
    const before = await ctx.db.supplierOrder.findUniqueOrThrow({ where: { id: sid } });
    await ctx.db.supplierOrder.update({ where: { id: sid }, data: { invoiceAmount } });
    await audit(ctx.db, ctx.user.id, 'supplierOrder.invoice', 'supplierOrder', sid, { invoiceAmount: before.invoiceAmount }, { invoiceAmount });
    return ok(c, { ok: true });
  });

  app.get('/api/supplier/balance', async (c) => {
    const ctx = c.get('ctx');
    requireRole(ctx.user, 'OWNER');
    const payments = await ctx.db.supplierPayment.findMany({ where: { voidedAt: null }, orderBy: { paidAt: 'desc' }, take: 50 });
    return ok(c, { ...(await supplierBalance(ctx.db)), payments });
  });

  app.post('/api/supplier-payments', async (c) => {
    const ctx = c.get('ctx');
    const input = parse(
      z.object({ amount: money.min(1), method: z.enum(['CASH', 'CARD', 'TRANSFER']), date: dateSchema.optional(), supplierOrderId: id.nullable().optional(), comment: text(300).nullable().optional() }),
      await body(c),
    );
    return ok(c, await addSupplierPayment(ctx, input));
  });
}
