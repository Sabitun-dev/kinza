import type { Ctx } from '../core/context.ts';
import type { Tx } from '../core/db.ts';
import { inTx } from '../core/db.ts';
import { AppError, bad, forbidden, notFound } from '../core/errors.ts';
import { audit } from '../core/audit.ts';
import { nextNumber, formatDocNumber } from '../core/counters.ts';
import { isOwner } from '../core/permissions.ts';
import type { PayMethod } from '../generated/prisma/enums.ts';
import { checkAgentOrderDiscount, checkAgentPrice, pricesForShop, type ResolvedPrice } from './pricing.ts';
import { reallocateShop, shopBalances } from './ledger.ts';
import { stockLevels } from './stockLevels.ts';
import { carOf, movement, putBack, takeFifoOrThrow, WAREHOUSE, type Place } from './stock.ts';
import { bizInfo, notifyOwners, sendDocumentToChat, shopParty, storeDocument, voidDocuments, esc } from './docs.ts';
import { orderDocument, type DocLine } from '../pdf/documents.ts';
import { addDays, addWorkingDays, fromDbDate, localDate, toDbDate } from '../shared/dates.ts';
import { formatMoney } from '../shared/money.ts';
import { priceFor, formatQty } from '../shared/qty.ts';
import { t } from '../shared/i18n/index.ts';

export interface LineInput {
  productId: number;
  qtyCans: number;
  pricePerPack?: number;
  pricePerCan?: number;
  isBonus?: boolean;
}

export interface OrderInput {
  shopId: number;
  lines: LineInput[];
  discount?: number;
  deliveryDate?: string;
  comment?: string | null;
  confirm?: boolean;
  idempotencyKey?: string;
  force?: boolean;
  offline?: boolean;
}

type ProductRow = { id: number; flavour: string; name: string; packSize: number; archivedAt: Date | null };

export interface BuiltLine {
  productId: number;
  qtyCans: number;
  orderedCans: number;
  packSize: number;
  pricePerPack: number;
  pricePerCan: number;
  basePerPack: number;
  basePerCan: number;
  isBonus: boolean;
  lineTotal: number;
  sortOrder: number;
}

/** Prices each line (resolved price unless edited) and computes totals. Pure. */
export function buildLines(lines: LineInput[], products: Map<number, ProductRow>, prices: Map<number, ResolvedPrice>, discount = 0) {
  const built: BuiltLine[] = lines.map((l, i) => {
    const p = products.get(l.productId);
    if (!p) throw bad('Mahsulot topilmadi');
    if (!Number.isInteger(l.qtyCans) || l.qtyCans <= 0) throw bad(`${p.flavour}: miqdor noto'g'ri`);
    const base = prices.get(l.productId) ?? { perPack: 0, perCan: 0 };
    const isBonus = !!l.isBonus;
    const perPack = isBonus ? 0 : (l.pricePerPack ?? base.perPack);
    const perCan = isBonus ? 0 : (l.pricePerCan ?? base.perCan);
    return {
      productId: l.productId,
      qtyCans: l.qtyCans,
      orderedCans: l.qtyCans,
      packSize: p.packSize,
      pricePerPack: perPack,
      pricePerCan: perCan,
      basePerPack: base.perPack,
      basePerCan: base.perCan,
      isBonus,
      lineTotal: isBonus ? 0 : priceFor(l.qtyCans, p.packSize, perPack, perCan),
      sortOrder: i,
    };
  });
  return { lines: built, ...totals(built, discount) };
}

export function totals(lines: { lineTotal: number; isBonus: boolean; qtyCans: number; packSize: number; basePerPack: number; basePerCan: number }[], discount: number) {
  const subtotal = lines.reduce((s, l) => s + (l.isBonus ? 0 : l.lineTotal), 0);
  const d = Math.max(0, Math.min(discount, subtotal));
  // Value at the normal price, bonus goods included (for the agent discount limit)
  const baseTotal = lines.reduce((s, l) => s + priceFor(l.qtyCans, l.packSize, l.basePerPack, l.basePerCan), 0);
  return { subtotal, discount: d, total: subtotal - d, baseTotal };
}

/** Agent limits: per-line price and whole-order discount (bonus counts as discount). */
export function enforceAgentLimits(ctx: Ctx, built: ReturnType<typeof buildLines>, prices: Map<number, ResolvedPrice>) {
  if (isOwner(ctx.user)) return;
  const maxBp = ctx.settings.agentMaxDiscountBp;
  for (const l of built.lines) {
    if (l.isBonus) continue;
    const r = prices.get(l.productId)!;
    const err = checkAgentPrice({
      base: { perPack: l.basePerPack, perCan: l.basePerCan },
      price: { perPack: l.pricePerPack, perCan: l.pricePerCan },
      min: { perPack: r.minPerPack, perCan: r.minPerCan },
      maxDiscountBp: maxBp,
    });
    if (err) throw new AppError(err, 400, 'price_limit');
  }
  const err = checkAgentOrderDiscount(built.baseTotal, built.total, maxBp);
  if (err) throw new AppError(err, 400, 'price_limit');
}

export async function loadProducts(tx: Tx, ids: number[]) {
  const rows = await tx.product.findMany({ where: { id: { in: ids } } });
  return new Map(rows.map((p) => [p.id, p]));
}

/** Warnings shown before confirming: credit limit and overdue debt. */
export async function creditWarnings(tx: Tx, ctx: Ctx, shopId: number, newTotal: number, excludeOrderId?: number) {
  const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
  const today = localDate(ctx.now());
  const bal = (await shopBalances(tx, today, [shopId])).get(shopId)!;
  const pending = await tx.order.aggregate({
    where: { shopId, status: { in: ['CONFIRMED', 'IN_TRANSIT'] }, ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}) },
    _sum: { total: true },
  });
  const warnings: string[] = [];
  if (bal.overdue > 0) warnings.push(`Muddati o'tgan qarz bor: ${formatMoney(bal.overdue)}`);
  if (shop.creditLimit != null) {
    const after = bal.balance + (pending._sum.total ?? 0) + newTotal;
    if (after > shop.creditLimit) warnings.push(`Kredit limiti oshadi: ${formatMoney(after)} > ${formatMoney(shop.creditLimit)}`);
  }
  return warnings;
}

async function lockOrder(tx: Tx, id: number) {
  await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${id} FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id }, include: { items: { include: { product: true }, orderBy: { sortOrder: 'asc' } }, shop: true } });
  if (!order) throw notFound('Buyurtma topilmadi');
  return order;
}

function canTouchOrder(ctx: Ctx, order: { agentId: number | null; shop: { agentId: number | null } }) {
  if (isOwner(ctx.user)) return true;
  if (ctx.user.role === 'AGENT') return order.agentId === ctx.user.id || order.shop.agentId === ctx.user.id;
  return false;
}

function docLinesOf(items: { product: { flavour: string; name: string }; qtyCans: number; packSize: number; pricePerPack: number; pricePerCan: number; isBonus: boolean; lineTotal: number }[]): DocLine[] {
  return items
    .filter((i) => i.qtyCans > 0)
    .map((i) => ({
      flavour: `${i.product.name} ${i.product.flavour}`,
      qtyCans: i.qtyCans,
      packSize: i.packSize,
      pricePerPack: i.pricePerPack,
      pricePerCan: i.pricePerCan,
      isBonus: i.isBonus,
      lineTotal: i.lineTotal,
    }));
}

/** Default delivery date: today + N working days (Sundays skipped if set). */
export function defaultDeliveryDate(ctx: Ctx) {
  return addWorkingDays(localDate(ctx.now()), ctx.settings.deliveryDays, ctx.settings.skipSundays);
}

// ───────────────────────── Create / edit ─────────────────────────

export async function createOrder(ctx: Ctx, input: OrderInput) {
  if (!isOwner(ctx.user) && ctx.user.role !== 'AGENT') throw forbidden();
  if (!input.lines.length) throw bad("Kamida bitta mahsulot qo'shing");

  // Same idempotency key = same order (offline retries, double taps)
  if (input.idempotencyKey) {
    const existing = await ctx.db.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (existing.status === 'DRAFT' && input.confirm && !existing.syncNote) {
        return { ...(await tryConfirm(ctx, existing.id, input)), duplicate: true };
      }
      return { id: existing.id, number: existing.number, status: existing.status, duplicate: true };
    }
  }

  const shop = await ctx.db.shop.findFirst({ where: { id: input.shopId, archivedAt: null } });
  if (!shop) throw notFound("Do'kon topilmadi");
  if (ctx.user.role === 'AGENT' && shop.agentId !== ctx.user.id) throw notFound("Do'kon topilmadi");

  const deliveryDate = input.deliveryDate ?? defaultDeliveryDate(ctx);
  if (deliveryDate < localDate(ctx.now())) throw bad("Yetkazish sanasi o'tib ketgan");

  const order = await inTx(ctx.db, async (tx) => {
    const products = await loadProducts(tx, input.lines.map((l) => l.productId));
    for (const p of products.values()) if (p.archivedAt) throw bad(`${p.flavour} arxivda`);
    const prices = await pricesForShop(tx, input.shopId, ctx.now());
    const built = buildLines(input.lines, products, prices, input.discount ?? 0);
    enforceAgentLimits(ctx, built, prices);
    const year = Number(localDate(ctx.now()).slice(0, 4));
    const n = await nextNumber(tx, 'ORDER', year);
    const o = await tx.order.create({
      data: {
        number: formatDocNumber(ctx.settings.orderPrefix, year, n, ctx.settings.numberDigits),
        shopId: input.shopId,
        agentId: ctx.user.id,
        status: 'DRAFT',
        deliveryDate: toDbDate(deliveryDate),
        subtotal: built.subtotal,
        discount: built.discount,
        total: built.total,
        comment: input.comment || null,
        idempotencyKey: input.idempotencyKey ?? null,
        items: { create: built.lines },
      },
    });
    await audit(tx, ctx.user.id, 'order.create', 'order', o.id, undefined, { number: o.number, total: o.total, lines: built.lines });
    return o;
  });

  if (input.confirm) return tryConfirm(ctx, order.id, input);
  return { id: order.id, number: order.number, status: order.status };
}

/** Confirms; on a business warning returns it instead of throwing (the draft stays). */
async function tryConfirm(ctx: Ctx, id: number, input: { force?: boolean; offline?: boolean }) {
  try {
    return await confirmOrder(ctx, id, { force: input.force });
  } catch (e) {
    if (e instanceof AppError && ['no_stock', 'credit_warning'].includes(e.code)) {
      const o = await ctx.db.order.update({ where: { id }, data: { syncNote: input.offline ? e.message : null } });
      return { id, number: o.number, status: o.status, confirmError: { code: e.code, message: e.message, details: e.details } };
    }
    throw e;
  }
}

export async function updateOrder(ctx: Ctx, id: number, input: Omit<OrderInput, 'shopId' | 'confirm'>) {
  const result = await inTx(ctx.db, async (tx) => {
    const order = await lockOrder(tx, id);
    if (!canTouchOrder(ctx, order)) throw notFound('Buyurtma topilmadi');
    if (!['DRAFT', 'CONFIRMED', 'IN_TRANSIT'].includes(order.status)) {
      throw bad("Yetkazilgan buyurtmani o'zgartirish uchun «Tuzatish» qiling");
    }
    if (!input.lines.length) throw bad("Kamida bitta mahsulot qo'shing");
    const products = await loadProducts(tx, input.lines.map((l) => l.productId));
    const prices = await pricesForShop(tx, order.shopId, ctx.now());
    const built = buildLines(input.lines, products, prices, input.discount ?? 0);
    enforceAgentLimits(ctx, built, prices);
    if (order.status !== 'DRAFT') {
      await checkBeforeConfirm(tx, ctx, order.shopId, built, id, input.force);
    }
    await tx.orderItem.deleteMany({ where: { orderId: id } });
    const updated = await tx.order.update({
      where: { id },
      data: {
        subtotal: built.subtotal,
        discount: built.discount,
        total: built.total,
        deliveryDate: input.deliveryDate ? toDbDate(input.deliveryDate) : undefined,
        comment: input.comment === undefined ? undefined : input.comment || null,
        syncNote: null,
        items: { create: built.lines },
      },
    });
    await audit(tx, ctx.user.id, 'order.update', 'order', id, { total: order.total, items: order.items }, { total: built.total, lines: built.lines });
    let docId: number | null = null;
    if (order.status !== 'DRAFT') {
      await voidDocuments(tx, ctx.blobs, { orderId: id, kind: 'ORDER_CONFIRMATION' }, "Buyurtma o'zgartirildi");
      docId = await makeConfirmationDoc(tx, ctx, id);
    }
    return { order: updated, docId };
  });
  if (result.docId) await sendOrderPdf(ctx, result.docId, id, "Buyurtma o'zgartirildi ✏️");
  return { id, status: result.order.status };
}

async function checkBeforeConfirm(tx: Tx, ctx: Ctx, shopId: number, built: { total: number; lines: { productId: number; qtyCans: number }[] }, excludeOrderId: number, force?: boolean) {
  if (!ctx.settings.allowConfirmWithoutStock) {
    const need = new Map<number, number>();
    for (const l of built.lines) need.set(l.productId, (need.get(l.productId) ?? 0) + l.qtyCans);
    const levels = await stockLevels(tx, [...need.keys()]);
    const mine = await tx.orderItem.groupBy({ by: ['productId'], where: { orderId: excludeOrderId, order: { status: { in: ['CONFIRMED', 'IN_TRANSIT'] } } }, _sum: { qtyCans: true } });
    const mineMap = new Map(mine.map((m) => [m.productId, m._sum.qtyCans ?? 0]));
    const products = await loadProducts(tx, [...need.keys()]);
    for (const [pid, qty] of need) {
      const avail = levels.get(pid)!.available + (mineMap.get(pid) ?? 0);
      if (avail < qty) {
        const p = products.get(pid)!;
        throw new AppError(`Omborda yetarli emas: ${p.flavour} — kerak ${formatQty(qty, p.packSize)}, mavjud ${formatQty(Math.max(0, avail), p.packSize)}`, 409, 'no_stock', { productId: pid });
      }
    }
  }
  const warnings = await creditWarnings(tx, ctx, shopId, built.total, excludeOrderId);
  if (warnings.length && !(isOwner(ctx.user) && force)) {
    throw new AppError(
      isOwner(ctx.user) ? warnings.join('. ') : `${warnings.join('. ')}. Egasi bilan gaplashing.`,
      409,
      'credit_warning',
      { warnings, canOverride: isOwner(ctx.user) },
    );
  }
}

// ───────────────────────── Status changes ─────────────────────────

async function makeConfirmationDoc(tx: Tx, ctx: Ctx, orderId: number) {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { include: { product: true }, orderBy: { sortOrder: 'asc' } }, shop: true } });
  const bytes = await orderDocument({
    kind: 'confirmation',
    number: o.number,
    date: localDate(ctx.now()),
    deliveryDate: fromDbDate(o.deliveryDate)!,
    business: await bizInfo(tx, ctx.blobs, ctx.settings),
    shop: shopParty(o.shop),
    lines: docLinesOf(o.items),
    subtotal: o.subtotal,
    discount: o.discount,
    total: o.total,
    comment: o.comment,
  });
  const doc = await storeDocument(tx, ctx, { kind: 'ORDER_CONFIRMATION', bytes, fileName: `Buyurtma-${o.number}.pdf`, number: o.number, orderId, shopId: o.shopId });
  return doc.id;
}

async function sendOrderPdf(ctx: Ctx, docId: number, orderId: number, title: string) {
  const o = await ctx.db.order.findUniqueOrThrow({ where: { id: orderId }, include: { shop: true, items: true } });
  const packs = Math.round(o.items.reduce((s, i) => s + i.qtyCans / i.packSize, 0) * 10) / 10;
  const caption = `${title}\n<b>${esc(o.shop.name)}</b> · ${o.number}\n${packs} blok · ${formatMoney(o.total)}\nYetkazish: ${fromDbDate(o.deliveryDate)}`;
  const buttons = [[{ text: t('bot.open'), app: `o_${orderId}` }]];
  await sendDocumentToChat(ctx, docId, ctx.user.telegramId, caption, buttons);
  if (!isOwner(ctx.user)) await notifyOwners(ctx, `👤 ${esc(ctx.user.name)}: ${caption}`, buttons);
}

export async function confirmOrder(ctx: Ctx, id: number, opts: { force?: boolean } = {}) {
  const result = await inTx(ctx.db, async (tx) => {
    const order = await lockOrder(tx, id);
    if (!canTouchOrder(ctx, order)) throw notFound('Buyurtma topilmadi');
    if (order.status !== 'DRAFT') return { order, docId: null as number | null, already: true };
    await checkBeforeConfirm(tx, ctx, order.shopId, { total: order.total, lines: order.items }, id, opts.force);
    const updated = await tx.order.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: ctx.now(), syncNote: null } });
    if (order.shop.status === 'LEAD' || order.shop.status === 'SAMPLE') {
      await tx.shop.update({ where: { id: order.shopId }, data: { status: 'ORDERED' } });
    }
    await audit(tx, ctx.user.id, 'order.confirm', 'order', id, { status: 'DRAFT' }, { status: 'CONFIRMED', forced: !!opts.force });
    const docId = await makeConfirmationDoc(tx, ctx, id);
    return { order: updated, docId, already: false };
  });
  if (result.docId) await sendOrderPdf(ctx, result.docId, id, t('docKind.ORDER_CONFIRMATION') + ' ✅');
  return { id, number: result.order.number, status: 'CONFIRMED' as const };
}

export async function shipOrder(ctx: Ctx, id: number, driverId?: number | null) {
  return inTx(ctx.db, async (tx) => {
    const order = await lockOrder(tx, id);
    const isDriver = ctx.user.role === 'DRIVER';
    if (!isOwner(ctx.user) && !(isDriver && (order.driverId === ctx.user.id || order.driverId == null))) throw forbidden();
    if (order.status !== 'CONFIRMED') throw bad("Faqat tasdiqlangan buyurtma yo'lga chiqadi");
    const updated = await tx.order.update({
      where: { id },
      data: { status: 'IN_TRANSIT', shippedAt: ctx.now(), driverId: isDriver ? ctx.user.id : driverId === undefined ? order.driverId : driverId },
    });
    await audit(tx, ctx.user.id, 'order.ship', 'order', id, { status: order.status }, { status: 'IN_TRANSIT', driverId: updated.driverId });
    return { id, status: updated.status };
  });
}

export async function assignDriver(ctx: Ctx, id: number, driverId: number | null) {
  if (!isOwner(ctx.user)) throw forbidden();
  if (driverId) {
    const d = await ctx.db.user.findFirst({ where: { id: driverId, role: 'DRIVER', active: true } });
    if (!d) throw bad('Haydovchi topilmadi');
  }
  const before = await ctx.db.order.findUniqueOrThrow({ where: { id } });
  if (before.status === 'DELIVERED' || before.status === 'CANCELLED') throw bad("Bu buyurtmaga haydovchi biriktirib bo'lmaydi");
  await ctx.db.order.update({ where: { id }, data: { driverId } });
  await audit(ctx.db, ctx.user.id, 'order.assignDriver', 'order', id, { driverId: before.driverId }, { driverId });
  if (driverId) {
    const d = await ctx.db.user.findUniqueOrThrow({ where: { id: driverId } });
    const shop = await ctx.db.shop.findUniqueOrThrow({ where: { id: before.shopId } });
    await ctx.notifier
      .sendMessage(Number(d.telegramId), `🚚 Sizga yetkazish biriktirildi: <b>${esc(shop.name)}</b>, ${fromDbDate(before.deliveryDate)}`, [[{ text: t('bot.open'), app: `o_${id}` }]])
      .catch(() => {});
  }
}

export async function cancelOrder(ctx: Ctx, id: number, reason: string) {
  if (!reason.trim()) throw bad('Sababini yozing');
  await inTx(ctx.db, async (tx) => {
    const order = await lockOrder(tx, id);
    if (!canTouchOrder(ctx, order)) throw notFound('Buyurtma topilmadi');
    if (order.status === 'DELIVERED') throw bad('Yetkazilgan buyurtma bekor qilinmaydi — qaytarish yoki tuzatish qiling');
    if (order.status === 'CANCELLED') return;
    if (!isOwner(ctx.user) && order.status === 'IN_TRANSIT') throw forbidden("Yo'ldagi buyurtmani faqat egasi bekor qiladi");
    await tx.order.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: ctx.now(), cancelReason: reason } });
    await voidDocuments(tx, ctx.blobs, { orderId: id, kind: 'ORDER_CONFIRMATION' }, `Bekor qilindi: ${reason}`);
    await audit(tx, ctx.user.id, 'order.cancel', 'order', id, { status: order.status }, { status: 'CANCELLED', reason });
  });
  return { id, status: 'CANCELLED' as const };
}

// ───────────────────────── Delivery ─────────────────────────

export interface DeliverInput {
  items?: { id: number; qtyCans: number }[];
  photoFileId?: number | null;
  payment?: { amount: number; method: PayMethod } | null;
}

/** Applies stock (FIFO) and cost to every line. Used by delivery and by revisions. */
export async function consumeForItems(tx: Tx, ctx: Ctx, order: { id: number; shopId: number }, revisionNote?: string, from: Place[] = [carOf(ctx.user.id), WAREHOUSE]) {
  const items = await tx.orderItem.findMany({ where: { orderId: order.id }, include: { product: true } });
  let costTotal = 0;
  for (const it of items) {
    if (it.qtyCans <= 0) continue;
    const taken = await takeFifoOrThrow(tx, it.product, it.qtyCans, ctx.settings.costMethod, from);
    let cost = 0;
    for (const tk of taken) {
      cost += tk.qtyCans * tk.costPerCan;
      await tx.orderItemBatch.create({ data: { orderItemId: it.id, batchId: tk.batchId, qtyCans: tk.qtyCans, costPerCan: tk.costPerCan } });
      await movement(tx, {
        productId: it.productId,
        batchId: tk.batchId,
        type: 'DELIVERY_OUT',
        qtyCans: -tk.qtyCans,
        costPerCan: tk.costPerCan,
        place: tk.place,
        carUserId: tk.carUserId,
        orderId: order.id,
        shopId: order.shopId,
        reason: revisionNote,
        userId: ctx.user.id,
      });
    }
    const rounded = Math.round(cost);
    costTotal += rounded;
    await tx.orderItem.update({ where: { id: it.id }, data: { costPerCan: cost / it.qtyCans, costTotal: rounded } });
  }
  return costTotal;
}

export async function makeWaybill(tx: Tx, ctx: Ctx, orderId: number, number: string, revision: number, revisionReason: string | null, paidNow: number) {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { include: { product: true }, orderBy: { sortOrder: 'asc' } }, shop: true } });
  const after = (await shopBalances(tx, localDate(ctx.now()), [o.shopId])).get(o.shopId)!.balance;
  const bytes = await orderDocument({
    kind: 'waybill',
    number,
    date: localDate(o.deliveredAt ?? ctx.now()),
    deliveryDate: fromDbDate(o.deliveryDate)!,
    business: await bizInfo(tx, ctx.blobs, ctx.settings),
    shop: shopParty(o.shop),
    lines: docLinesOf(o.items),
    subtotal: o.subtotal,
    discount: o.discount,
    total: o.total,
    prevDebt: after - o.total + paidNow,
    paidNow,
    newBalance: after,
    comment: o.comment,
    revision,
    revisionReason,
  });
  const doc = await storeDocument(tx, ctx, { kind: 'WAYBILL', bytes, fileName: `Nakladnoy-${number}.pdf`, number, revision, orderId, shopId: o.shopId });
  return doc.id;
}

export async function deliverOrder(ctx: Ctx, id: number, input: DeliverInput) {
  const result = await inTx(ctx.db, async (tx) => {
    const order = await lockOrder(tx, id);
    const isDriver = ctx.user.role === 'DRIVER';
    if (!isOwner(ctx.user) && !(isDriver && (order.driverId === ctx.user.id || order.driverId == null))) throw forbidden();
    if (order.status === 'DELIVERED') throw new AppError('Bu buyurtma allaqachon yetkazilgan', 409, 'already');
    if (order.status !== 'CONFIRMED' && order.status !== 'IN_TRANSIT') throw bad('Avval buyurtmani tasdiqlang');

    // The shop may take less than ordered
    const changes = new Map((input.items ?? []).map((i) => [i.id, i.qtyCans]));
    for (const it of order.items) {
      const qty = changes.get(it.id);
      if (qty === undefined || qty === it.qtyCans) continue;
      if (!Number.isInteger(qty) || qty < 0) throw bad("Miqdor noto'g'ri");
      if (qty > it.qtyCans) throw bad(`${it.product.flavour}: buyurtmadan ko'p yetkazib bo'lmaydi`);
      await tx.orderItem.update({
        where: { id: it.id },
        data: { qtyCans: qty, lineTotal: it.isBonus ? 0 : priceFor(qty, it.packSize, it.pricePerPack, it.pricePerCan) },
      });
    }
    const items = await tx.orderItem.findMany({ where: { orderId: id } });
    if (!items.some((i) => i.qtyCans > 0)) throw bad("Hammasi 0 bo'lsa, buyurtmani bekor qiling");
    const tt = totals(items, order.discount);

    const costTotal = await consumeForItems(tx, ctx, order);
    const today = localDate(ctx.now());
    const paymentDays = order.shop.paymentDays ?? ctx.settings.paymentDays;
    await tx.order.update({
      where: { id },
      data: {
        status: 'DELIVERED',
        deliveredAt: ctx.now(),
        dueDate: toDbDate(addDays(today, paymentDays)),
        subtotal: tt.subtotal,
        discount: tt.discount,
        total: tt.total,
        costTotal,
        deliveryPhotoFileId: input.photoFileId ?? null,
        driverId: isDriver ? ctx.user.id : order.driverId,
      },
    });

    let paidNow = 0;
    if (input.payment && input.payment.amount > 0) {
      paidNow = input.payment.amount;
      const pay = await tx.payment.create({
        data: {
          shopId: order.shopId,
          amount: paidNow,
          method: input.payment.method,
          paidAt: ctx.now(),
          receivedById: ctx.user.id,
          targetOrderId: id,
          handedOverAt: isOwner(ctx.user) ? ctx.now() : null,
          comment: `Yetkazishda: ${order.number}`,
        },
      });
      await audit(tx, ctx.user.id, 'payment.create', 'payment', pay.id, undefined, { amount: paidNow, method: pay.method, orderId: id });
    }
    await reallocateShop(tx, order.shopId);

    // Gap-free waybill number, issued in the same transaction as the delivery
    const year = Number(today.slice(0, 4));
    const n = await nextNumber(tx, 'WAYBILL', year);
    const number = formatDocNumber(ctx.settings.waybillPrefix, year, n, ctx.settings.numberDigits);
    const docId = await makeWaybill(tx, ctx, id, number, 0, null, paidNow);

    const delivered = await tx.order.count({ where: { shopId: order.shopId, status: 'DELIVERED', isOpening: false } });
    if (order.shop.status === 'ORDERED' && delivered >= 3) await tx.shop.update({ where: { id: order.shopId }, data: { status: 'REGULAR' } });
    if (order.shop.status === 'LEAD' || order.shop.status === 'SAMPLE') await tx.shop.update({ where: { id: order.shopId }, data: { status: 'ORDERED' } });

    await audit(
      tx,
      ctx.user.id,
      'order.deliver',
      'order',
      id,
      { status: order.status, total: order.total, items: order.items.map((i) => ({ id: i.id, qtyCans: i.qtyCans })) },
      { status: 'DELIVERED', total: tt.total, waybill: number, paidNow, items: items.map((i) => ({ id: i.id, qtyCans: i.qtyCans })) },
    );
    return { docId, number, total: tt.total, paidNow, shopName: order.shop.name };
  });

  const caption = `${t('docKind.WAYBILL')} ✅\n<b>${esc(result.shopName)}</b> · ${result.number}\nJami: ${formatMoney(result.total)}${result.paidNow ? `\nNaqd oldim: ${formatMoney(result.paidNow)}` : ''}`;
  const buttons = [[{ text: t('bot.open'), app: `o_${id}` }]];
  await sendDocumentToChat(ctx, result.docId, ctx.user.telegramId, caption, buttons);
  if (!isOwner(ctx.user)) {
    const owners = await ctx.db.user.findMany({ where: { role: 'OWNER', active: true } });
    for (const o of owners) await sendDocumentToChat(ctx, result.docId, Number(o.telegramId), `👤 ${esc(ctx.user.name)}: ${caption}`, buttons);
  }
  return { id, status: 'DELIVERED' as const, waybillNumber: result.number };
}

// ───────────────────────── Revision after delivery ─────────────────────────

export async function reviseOrder(ctx: Ctx, id: number, input: { lines: LineInput[]; discount?: number; reason: string }) {
  if (!isOwner(ctx.user)) throw forbidden('Yetkazilgan hujjatni faqat egasi tuzatadi');
  if (!input.reason?.trim()) throw bad('Tuzatish sababini yozing');
  if (!input.lines.length) throw bad("Kamida bitta mahsulot qo'shing");
  const result = await inTx(ctx.db, async (tx) => {
    const order = await lockOrder(tx, id);
    if (order.status !== 'DELIVERED' || order.isOpening) throw bad('Faqat yetkazilgan buyurtma tuzatiladi');
    const before = { total: order.total, discount: order.discount, items: order.items.map((i) => ({ productId: i.productId, qtyCans: i.qtyCans, pricePerPack: i.pricePerPack, pricePerCan: i.pricePerCan, isBonus: i.isBonus })) };
    const revision = order.revision + 1;
    const note = `Tuzatish ${revision}: ${input.reason}`;

    // 1. Put the old cans back into their batches
    const oldBatches = await tx.orderItemBatch.findMany({ where: { orderItem: { orderId: id } }, include: { orderItem: true, batch: true } });
    await putBack(tx, oldBatches);
    for (const b of oldBatches) {
      await movement(tx, { productId: b.orderItem.productId, batchId: b.batchId, type: 'DELIVERY_OUT', qtyCans: b.qtyCans, costPerCan: b.costPerCan, place: b.batch.place, carUserId: b.batch.carUserId, orderId: id, shopId: order.shopId, reason: note, userId: ctx.user.id });
    }
    await tx.orderItemBatch.deleteMany({ where: { orderItem: { orderId: id } } });
    await tx.orderItem.deleteMany({ where: { orderId: id } });

    // 2. New lines (prices as typed, otherwise the price at the time of the original order)
    const products = await loadProducts(tx, input.lines.map((l) => l.productId));
    const oldPrice = new Map(order.items.filter((i) => !i.isBonus).map((i) => [i.productId, { perPack: i.pricePerPack, perCan: i.pricePerCan, base: { perPack: i.basePerPack, perCan: i.basePerCan } }]));
    const current = await pricesForShop(tx, order.shopId, ctx.now());
    const prices = new Map([...current].map(([pid, r]) => [pid, oldPrice.has(pid) ? { ...r, perPack: oldPrice.get(pid)!.perPack, perCan: oldPrice.get(pid)!.perCan } : r]));
    const built = buildLines(input.lines, products, prices, input.discount ?? order.discount);
    await tx.order.update({
      where: { id },
      data: { subtotal: built.subtotal, discount: built.discount, total: built.total, revision, items: { create: built.lines } },
    });

    // 3. Take stock again and recompute cost
    const costTotal = await consumeForItems(tx, ctx, order, note);
    await tx.order.update({ where: { id }, data: { costTotal } });
    await reallocateShop(tx, order.shopId);

    // 4. Void the old nakladnoy (stamped) and issue the revised one with the same number + R
    const old = await tx.document.findFirst({ where: { orderId: id, kind: 'WAYBILL' }, orderBy: { createdAt: 'asc' } });
    const baseNumber = old?.number?.replace(/-R\d+$/, '') ?? order.number;
    await voidDocuments(tx, ctx.blobs, { orderId: id, kind: 'WAYBILL' }, note);
    const number = `${baseNumber}-R${revision}`;
    const docId = await makeWaybill(tx, ctx, id, number, revision, input.reason, 0);
    await audit(tx, ctx.user.id, 'order.revise', 'order', id, before, { reason: input.reason, revision, total: built.total, lines: built.lines });
    return { docId, number, total: built.total, shopName: order.shop.name };
  });
  await sendDocumentToChat(ctx, result.docId, ctx.user.telegramId, `✏️ Tuzatilgan yuk xati\n<b>${esc(result.shopName)}</b> · ${result.number}\nJami: ${formatMoney(result.total)}`, [[{ text: t('bot.open'), app: `o_${id}` }]]);
  return { id, number: result.number };
}
