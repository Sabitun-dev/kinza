import type { Ctx } from '../core/context.ts';
import type { DbOrTx } from '../core/db.ts';
import { inTx } from '../core/db.ts';
import { audit } from '../core/audit.ts';
import { bad, forbidden, notFound } from '../core/errors.ts';
import { nextNumber, formatDocNumber } from '../core/counters.ts';
import { isOwner } from '../core/permissions.ts';
import type { PayMethod } from '../generated/prisma/enums.ts';
import { currentPriceTable } from './pricing.ts';
import { stockLevels } from './stockLevels.ts';
import { movement } from './stock.ts';
import { bizInfo, esc, sendDocumentToChat, storeDocument } from './docs.ts';
import { supplierOrderDocument } from '../pdf/documents.ts';
import { addDays, addWorkingDays, fromDbDate, localDate, localTime, toDbDate } from '../shared/dates.ts';

// ───────────────────────── Proposal ─────────────────────────

export interface ProposalInput {
  ordersPacks: number; // confirmed orders for the covered dates, in packs (may be fractional)
  availablePacks: number; // on hand + already on the way
  safetyPacks: number;
  minPacks: number;
}

/** orders − available + safety, rounded up to whole packs and to the supplier minimum. */
export function proposePacks({ ordersPacks, availablePacks, safetyPacks, minPacks }: ProposalInput): number {
  const need = Math.ceil(ordersPacks - availablePacks + safetyPacks - 1e-9);
  if (need <= 0) return 0;
  return Math.max(need, minPacks);
}

/** The next shipment: ordered today before the cutoff, otherwise tomorrow; arrives after lead time. */
export function nextShipment(ctx: Ctx) {
  const today = localDate(ctx.now());
  const beforeCutoff = localTime(ctx.now()) < ctx.settings.supplierCutoffTime;
  const orderDay = beforeCutoff ? today : addDays(today, 1);
  const arrival = addWorkingDays(orderDay, Math.max(1, ctx.settings.supplierLeadDays), false);
  return { orderDay, arrival, coverUntil: addWorkingDays(arrival, 1, ctx.settings.skipSundays) };
}

export async function buildProposal(ctx: Ctx, coverUntil?: string) {
  const ship = nextShipment(ctx);
  const until = coverUntil ?? ship.coverUntil;
  const products = await ctx.db.product.findMany({ where: { archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { flavour: 'asc' }] });
  const [levels, demand, incoming, prices, lastCargo] = await Promise.all([
    stockLevels(ctx.db, products.map((p) => p.id)),
    ctx.db.orderItem.groupBy({
      by: ['productId'],
      where: { order: { status: { in: ['CONFIRMED', 'IN_TRANSIT'] }, deliveryDate: { lte: toDbDate(until) } } },
      _sum: { qtyCans: true },
    }),
    ctx.db.supplierOrderItem.findMany({ where: { supplierOrder: { status: { in: ['ORDERED', 'IN_TRANSIT'] } } } }),
    currentPriceTable(ctx.db),
    cargoPerPackEstimate(ctx.db),
  ]);
  const demandMap = new Map(demand.map((d) => [d.productId, d._sum.qtyCans ?? 0]));
  const incomingMap = new Map<number, number>();
  for (const i of incoming) incomingMap.set(i.productId, (incomingMap.get(i.productId) ?? 0) + i.orderedPacks);

  const lines = products.map((p) => {
    const ordersCans = demandMap.get(p.id) ?? 0;
    const inStock = levels.get(p.id)!.inStock;
    const incomingPacks = incomingMap.get(p.id) ?? 0;
    const ordersPacks = ordersCans / p.packSize;
    const availablePacks = inStock / p.packSize + incomingPacks;
    const packs = proposePacks({ ordersPacks, availablePacks, safetyPacks: ctx.settings.safetyStockPacks, minPacks: ctx.settings.supplierMinPacks });
    const sell = prices.get(`${p.id}:default`)?.perPack ?? 0;
    const cost = packs * (p.buyPricePerPack + lastCargo);
    return {
      productId: p.id,
      flavour: p.flavour,
      name: p.name,
      packSize: p.packSize,
      ordersPacks: Math.round(ordersPacks * 10) / 10,
      inStockPacks: Math.round((inStock / p.packSize) * 10) / 10,
      incomingPacks,
      proposedPacks: packs,
      buyPricePerPack: p.buyPricePerPack,
      sellPerPack: sell,
      expectedCost: cost,
      expectedRevenue: packs * sell,
      expectedProfit: packs * sell - cost,
    };
  });
  const sum = (k: 'proposedPacks' | 'expectedCost' | 'expectedRevenue' | 'expectedProfit') => lines.reduce((s, l) => s + l[k], 0);
  return {
    orderDay: ship.orderDay,
    arrivalDate: ship.arrival,
    coverUntil: until,
    cutoff: ctx.settings.supplierCutoffTime,
    cargoPerPack: lastCargo,
    lines,
    totals: { packs: sum('proposedPacks'), expectedCost: sum('expectedCost'), expectedRevenue: sum('expectedRevenue'), expectedProfit: sum('expectedProfit') },
  };
}

/** Average cargo cost per pack of the last received shipment (estimate for the proposal). */
async function cargoPerPackEstimate(db: DbOrTx) {
  const last = await db.supplierOrder.findFirst({ where: { status: 'RECEIVED' }, orderBy: { receivedAt: 'desc' }, include: { costs: true, items: true } });
  if (!last) return 0;
  const packs = last.items.reduce((s, i) => s + (i.receivedCans ?? 0) + (i.damagedCans ?? 0), 0) / 24;
  const cargo = last.costs.reduce((s, c) => s + c.amount, 0);
  return packs ? Math.round(cargo / packs) : 0;
}

// ───────────────────────── Supplier orders ─────────────────────────

export interface SupplierLine {
  productId: number;
  orderedPacks: number;
  proposedPacks?: number;
  buyPricePerPack?: number;
}

export async function createSupplierOrder(ctx: Ctx, input: { lines: SupplierLine[]; arrivalDate?: string; coverUntil?: string; comment?: string | null }) {
  if (!isOwner(ctx.user)) throw forbidden();
  const lines = input.lines.filter((l) => l.orderedPacks > 0);
  if (!lines.length) throw bad("Kamida bitta ta'm kiriting");
  return inTx(ctx.db, async (tx) => {
    const products = new Map((await tx.product.findMany({ where: { id: { in: lines.map((l) => l.productId) } } })).map((p) => [p.id, p]));
    const year = Number(localDate(ctx.now()).slice(0, 4));
    const n = await nextNumber(tx, 'SUPPLIER', year);
    const so = await tx.supplierOrder.create({
      data: {
        number: formatDocNumber(ctx.settings.supplierOrderPrefix, year, n, 3),
        status: 'DRAFT',
        arrivalDate: input.arrivalDate ? toDbDate(input.arrivalDate) : null,
        coverUntil: input.coverUntil ? toDbDate(input.coverUntil) : null,
        comment: input.comment || null,
        createdById: ctx.user.id,
        items: {
          create: lines.map((l) => ({
            productId: l.productId,
            orderedPacks: l.orderedPacks,
            proposedPacks: l.proposedPacks ?? 0,
            buyPricePerPack: l.buyPricePerPack ?? products.get(l.productId)?.buyPricePerPack ?? 0,
          })),
        },
      },
    });
    await audit(tx, ctx.user.id, 'supplierOrder.create', 'supplierOrder', so.id, undefined, { number: so.number, lines });
    return { id: so.id, number: so.number };
  });
}

export async function updateSupplierOrder(ctx: Ctx, id: number, input: { lines: SupplierLine[]; arrivalDate?: string | null; comment?: string | null }) {
  if (!isOwner(ctx.user)) throw forbidden();
  return inTx(ctx.db, async (tx) => {
    const so = await tx.supplierOrder.findUnique({ where: { id }, include: { items: true } });
    if (!so) throw notFound();
    if (so.status === 'RECEIVED' || so.status === 'CANCELLED') throw bad("Qabul qilingan buyurtmani o'zgartirib bo'lmaydi");
    const products = new Map((await tx.product.findMany()).map((p) => [p.id, p]));
    await tx.supplierOrderItem.deleteMany({ where: { supplierOrderId: id } });
    await tx.supplierOrderItem.createMany({
      data: input.lines
        .filter((l) => l.orderedPacks > 0)
        .map((l) => ({
          supplierOrderId: id,
          productId: l.productId,
          orderedPacks: l.orderedPacks,
          proposedPacks: l.proposedPacks ?? so.items.find((i) => i.productId === l.productId)?.proposedPacks ?? 0,
          buyPricePerPack: l.buyPricePerPack ?? products.get(l.productId)?.buyPricePerPack ?? 0,
        })),
    });
    await tx.supplierOrder.update({
      where: { id },
      data: { arrivalDate: input.arrivalDate === undefined ? undefined : input.arrivalDate ? toDbDate(input.arrivalDate) : null, comment: input.comment === undefined ? undefined : input.comment },
    });
    await audit(tx, ctx.user.id, 'supplierOrder.update', 'supplierOrder', id, so.items, input.lines);
  });
}

export async function setSupplierStatus(ctx: Ctx, id: number, status: 'ORDERED' | 'IN_TRANSIT' | 'CANCELLED') {
  if (!isOwner(ctx.user)) throw forbidden();
  const so = await ctx.db.supplierOrder.findUnique({ where: { id } });
  if (!so) throw notFound();
  const allowed: Record<string, string[]> = { DRAFT: ['ORDERED', 'CANCELLED'], ORDERED: ['IN_TRANSIT', 'CANCELLED'], IN_TRANSIT: ['CANCELLED'] };
  if (!allowed[so.status]?.includes(status)) throw bad("Bu holatga o'tkazib bo'lmaydi");
  await ctx.db.supplierOrder.update({
    where: { id },
    data: { status, orderedAt: status === 'ORDERED' ? ctx.now() : undefined, cancelledAt: status === 'CANCELLED' ? ctx.now() : undefined },
  });
  await audit(ctx.db, ctx.user.id, 'supplierOrder.status', 'supplierOrder', id, { status: so.status }, { status });
}

/** Sends the order to my chat as neat text (to forward to the supplier) or as a PDF. */
export async function sendSupplierOrder(ctx: Ctx, id: number, format: 'text' | 'pdf') {
  const so = await ctx.db.supplierOrder.findUnique({ where: { id }, include: { items: { include: { product: true } } } });
  if (!so) throw notFound();
  const lines = so.items.map((i) => ({ flavour: `${i.product.name} ${i.product.flavour}`, packs: i.orderedPacks, pricePerPack: i.buyPricePerPack }));
  const total = lines.reduce((s, l) => s + l.packs, 0);
  if (format === 'text') {
    const text = [
      `📦 <b>Buyurtma ${so.number}</b>`,
      `${ctx.settings.businessName}${ctx.settings.businessPhone ? ' · ' + ctx.settings.businessPhone : ''}`,
      so.arrivalDate ? `Kerak: ${fromDbDate(so.arrivalDate)}` : '',
      '',
      ...lines.map((l, i) => `${i + 1}. ${esc(l.flavour)} — <b>${l.packs} blok</b>`),
      '',
      `Jami: <b>${total} blok</b>`,
      so.comment ? `\n${esc(so.comment)}` : '',
    ]
      .filter((x) => x !== null)
      .join('\n');
    await ctx.notifier.sendMessage(ctx.user.telegramId, text.replace(/\n{3,}/g, '\n\n'));
    return { ok: true };
  }
  const docId = await inTx(ctx.db, async (tx) => {
    const bytes = await supplierOrderDocument({
      number: so.number,
      date: localDate(ctx.now()),
      arrivalDate: fromDbDate(so.arrivalDate),
      business: await bizInfo(tx, ctx.blobs, ctx.settings),
      supplierName: ctx.settings.supplierName,
      lines,
      showPrices: false,
      comment: so.comment,
    });
    const doc = await storeDocument(tx, ctx, { kind: 'SUPPLIER_ORDER', bytes, fileName: `Toshkent-${so.number}.pdf`, number: so.number, supplierOrderId: so.id });
    return doc.id;
  });
  await sendDocumentToChat(ctx, docId, ctx.user.telegramId, `📦 ${so.number} · ${total} blok`);
  return { ok: true };
}

// ───────────────────────── Receiving ─────────────────────────

export interface ReceiveInput {
  lines: { itemId: number; receivedCans: number; damagedCans?: number; expiry?: string | null; buyPricePerPack?: number }[];
  cargoCost?: number;
  invoiceAmount?: number | null;
}

/** Landed cost per pack = buying price + cargo spread over every pack that arrived. */
export function landedPerPack(buyPricePerPack: number, cargoTotal: number, totalPacks: number) {
  return buyPricePerPack + (totalPacks > 0 ? cargoTotal / totalPacks : 0);
}

export async function receiveSupplierOrder(ctx: Ctx, id: number, input: ReceiveInput) {
  if (!isOwner(ctx.user) && ctx.user.role !== 'DRIVER') throw forbidden();
  const owner = isOwner(ctx.user);
  return inTx(ctx.db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM "supplier_orders" WHERE id = ${id} FOR UPDATE`;
    const so = await tx.supplierOrder.findUnique({ where: { id }, include: { items: { include: { product: true } }, costs: true } });
    if (!so) throw notFound();
    if (so.status === 'RECEIVED') throw bad('Bu yuk allaqachon qabul qilingan');
    if (so.status === 'CANCELLED') throw bad('Bekor qilingan buyurtma');

    if (owner && input.cargoCost && input.cargoCost > 0) {
      await tx.shipmentCost.create({ data: { supplierOrderId: id, kind: 'cargo', amount: input.cargoCost, comment: 'Yuk tashish' } });
    }
    const cargo = (await tx.shipmentCost.findMany({ where: { supplierOrderId: id } })).reduce((s, c) => s + c.amount, 0);
    const byItem = new Map(input.lines.map((l) => [l.itemId, l]));
    const arrived = so.items.map((i) => {
      const l = byItem.get(i.id);
      const good = l?.receivedCans ?? 0;
      const damaged = l?.damagedCans ?? 0;
      if (good < 0 || damaged < 0) throw bad("Miqdor noto'g'ri");
      const price = owner && l?.buyPricePerPack != null ? l.buyPricePerPack : i.buyPricePerPack;
      return { item: i, good, damaged, price, expiry: l?.expiry ?? null };
    });
    const totalPacks = arrived.reduce((s, a) => s + (a.good + a.damaged) / a.item.product.packSize, 0);
    if (totalPacks <= 0) throw bad("Hech narsa kelmadimi? Miqdorlarni kiriting yoki buyurtmani bekor qiling");

    let invoice = 0;
    for (const a of arrived) {
      const p = a.item.product;
      const perPack = landedPerPack(a.price, cargo, totalPacks);
      const perCan = perPack / p.packSize;
      invoice += Math.round(((a.good + a.damaged) / p.packSize) * a.price);
      await tx.supplierOrderItem.update({
        where: { id: a.item.id },
        data: { receivedCans: a.good, damagedCans: a.damaged, expiry: a.expiry ? toDbDate(a.expiry) : null, buyPricePerPack: a.price },
      });
      if (a.good > 0) {
        const batch = await tx.stockBatch.create({
          data: { productId: p.id, supplierOrderId: id, expiry: a.expiry ? toDbDate(a.expiry) : null, landedCostPerCan: perCan, receivedCans: a.good, remainingCans: a.good },
        });
        await movement(tx, { productId: p.id, batchId: batch.id, type: 'SUPPLIER_IN', qtyCans: a.good, costPerCan: perCan, supplierOrderId: id, userId: ctx.user.id });
      }
      if (a.damaged > 0) {
        await movement(tx, { productId: p.id, type: 'ARRIVAL_DAMAGED', pool: 'DAMAGED', qtyCans: a.damaged, costPerCan: perCan, supplierOrderId: id, userId: ctx.user.id, reason: 'Kelganda shikastlangan' });
      }
      if (owner && a.price !== p.buyPricePerPack) {
        await tx.product.update({ where: { id: p.id }, data: { buyPricePerPack: a.price } });
        await audit(tx, ctx.user.id, 'product.buyPrice', 'product', p.id, { buyPricePerPack: p.buyPricePerPack }, { buyPricePerPack: a.price });
      }
    }
    await tx.supplierOrder.update({
      where: { id },
      data: {
        status: 'RECEIVED',
        receivedAt: ctx.now(),
        invoiceAmount: owner && input.invoiceAmount != null ? input.invoiceAmount : (so.invoiceAmount ?? invoice),
      },
    });
    await audit(tx, ctx.user.id, 'supplierOrder.receive', 'supplierOrder', id, undefined, {
      cargo,
      lines: arrived.map((a) => ({ productId: a.item.productId, ordered: a.item.orderedPacks, good: a.good, damaged: a.damaged, expiry: a.expiry })),
    });
    return {
      id,
      differences: arrived
        .filter((a) => a.good + a.damaged !== a.item.orderedPacks * a.item.product.packSize)
        .map((a) => ({ flavour: a.item.product.flavour, orderedCans: a.item.orderedPacks * a.item.product.packSize, arrivedCans: a.good + a.damaged })),
    };
  });
}

export async function addSupplierPayment(ctx: Ctx, input: { amount: number; method: PayMethod; date?: string; supplierOrderId?: number | null; comment?: string | null }) {
  if (!isOwner(ctx.user)) throw forbidden();
  const p = await ctx.db.supplierPayment.create({
    data: {
      amount: input.amount,
      method: input.method,
      paidAt: input.date ? new Date(input.date + 'T07:00:00Z') : ctx.now(),
      supplierOrderId: input.supplierOrderId ?? null,
      comment: input.comment || null,
      createdById: ctx.user.id,
    },
  });
  await audit(ctx.db, ctx.user.id, 'supplierPayment.create', 'supplierPayment', p.id, undefined, input);
  return { id: p.id };
}

/** What I owe the supplier: invoices of received shipments − supplier payments. */
export async function supplierBalance(db: DbOrTx) {
  const [inv, paid] = await Promise.all([
    db.supplierOrder.aggregate({ where: { status: { not: 'CANCELLED' }, invoiceAmount: { not: null } }, _sum: { invoiceAmount: true } }),
    db.supplierPayment.aggregate({ where: { voidedAt: null }, _sum: { amount: true } }),
  ]);
  const invoiced = inv._sum.invoiceAmount ?? 0;
  const payments = paid._sum.amount ?? 0;
  return { invoiced, paid: payments, balance: invoiced - payments };
}

export function cutoffText(arrival: string, cutoff: string) {
  return `${arrival} yetkazish uchun bugun ${cutoff} gacha Toshkentga buyurtma bering.`;
}

