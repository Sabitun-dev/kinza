import type { Ctx } from '../core/context.ts';
import type { Tx } from '../core/db.ts';
import { inTx } from '../core/db.ts';
import { AppError, bad, notFound } from '../core/errors.ts';
import { audit } from '../core/audit.ts';
import { nextNumber, formatDocNumber } from '../core/counters.ts';
import { isOwner } from '../core/permissions.ts';
import { fileUrl } from '../core/files.ts';
import type { PayMethod, ReturnCondition } from '../generated/prisma/enums.ts';
import { buildLines, consumeForItems, createOrder, creditWarnings, enforceAgentLimits, loadProducts, makeWaybill, type LineInput } from './orders.ts';
import { pricesForShop } from './pricing.ts';
import { reallocateShop, shopBalances } from './ledger.ts';
import { createReturnInTx } from './payments.ts';
import { carOf } from './stock.ts';
import { placeLevels } from './stockOps.ts';
import { esc, notifyOwners, sendDocumentToChat } from './docs.ts';
import { itemForShop, setItemStatus, workingDayOnOrAfter } from '../checklist/checklist.ts';
import { addDays, localDate, nextWeekday, toDbDate } from '../shared/dates.ts';
import { formatMoney } from '../shared/money.ts';
import { t } from '../shared/i18n/index.ts';

type Pos = { lat: number; lng: number } | null | undefined;

export interface SellInput {
  shopId: number;
  orderId?: number | null; // deliver this pre-order
  lines: LineInput[];
  discount?: number;
  comment?: string | null;
  payment?: { amount: number; method: PayMethod } | null;
  returns?: { productId: number; qtyCans: number; condition: ReturnCondition }[];
  returnReason?: string | null;
  idempotencyKey: string;
  pos?: Pos;
  force?: boolean;
}

/** The same request sent twice (offline retry, double tap) returns the first result. */
async function once<T extends object>(ctx: Ctx, key: string, kind: string, fn: (tx: Tx) => Promise<T>): Promise<T & { duplicate?: boolean }> {
  const prev = await ctx.db.syncRequest.findUnique({ where: { key } });
  if (prev) return { ...(prev.result as T), duplicate: true };
  try {
    return await inTx(ctx.db, async (tx) => {
      const result = await fn(tx);
      await tx.syncRequest.create({ data: { key, userId: ctx.user.id, kind, result: result as never } });
      return result;
    });
  } catch (e) {
    const again = await ctx.db.syncRequest.findUnique({ where: { key } });
    if (again) return { ...(again.result as T), duplicate: true }; // a parallel copy won
    throw e;
  }
}

async function payNow(tx: Tx, ctx: Ctx, shopId: number, payment: SellInput['payment'], comment: string) {
  if (!payment || payment.amount <= 0) return 0;
  const p = await tx.payment.create({
    data: { shopId, amount: payment.amount, method: payment.method, paidAt: ctx.now(), receivedById: ctx.user.id, handedOverAt: isOwner(ctx.user) ? ctx.now() : null, comment },
  });
  await audit(tx, ctx.user.id, 'payment.create', 'payment', p.id, undefined, { shopId, amount: payment.amount, method: payment.method });
  return payment.amount;
}

/**
 * "Sotish" at a shop: order + delivery from the car + nakladnoy + optional payment + optional return
 * + visit + checklist status. Everything is saved together, or nothing is.
 */
export async function sell(ctx: Ctx, input: SellInput) {
  if (!input.lines.length) throw bad("Kamida bitta mahsulot qo'shing");
  const today = localDate(ctx.now());
  const result = await once(ctx, input.idempotencyKey, 'sell', async (tx) => {
    const shop = await tx.shop.findUniqueOrThrow({ where: { id: input.shopId } });
    const products = await loadProducts(tx, input.lines.map((l) => l.productId));
    const prices = await pricesForShop(tx, input.shopId, ctx.now());
    const built = buildLines(input.lines, products, prices, input.discount ?? 0);
    enforceAgentLimits(ctx, built, prices);

    // Credit limit / overdue debt: owner may confirm anyway, an agent may not
    const warnings = await creditWarnings(tx, ctx, input.shopId, built.total, input.orderId ?? undefined);
    if (warnings.length && !(isOwner(ctx.user) && input.force)) {
      throw new AppError(isOwner(ctx.user) ? warnings.join('. ') : `${warnings.join('. ')}. Egasi bilan gaplashing.`, 409, 'credit_warning', { warnings, canOverride: isOwner(ctx.user) });
    }

    const year = Number(today.slice(0, 4));
    const paymentDays = shop.paymentDays ?? ctx.settings.paymentDays;
    const common = {
      status: 'DELIVERED' as const,
      deliveredAt: ctx.now(),
      confirmedAt: ctx.now(),
      dueDate: toDbDate(addDays(today, paymentDays)),
      subtotal: built.subtotal,
      discount: built.discount,
      total: built.total,
      comment: input.comment || null,
    };
    let orderId: number;
    if (input.orderId) {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${input.orderId} FOR UPDATE`;
      const pre = await tx.order.findFirst({ where: { id: input.orderId, shopId: input.shopId } });
      if (!pre) throw notFound('Buyurtma topilmadi');
      if (pre.status !== 'CONFIRMED' && pre.status !== 'IN_TRANSIT') throw new AppError('Bu buyurtma allaqachon yetkazilgan yoki bekor qilingan', 409, 'already');
      await tx.orderItem.deleteMany({ where: { orderId: pre.id } });
      await tx.order.update({ where: { id: pre.id }, data: { ...common, comment: input.comment ?? pre.comment, items: { create: built.lines } } });
      orderId = pre.id;
    } else {
      const n = await nextNumber(tx, 'ORDER', year);
      const o = await tx.order.create({
        data: {
          number: formatDocNumber(ctx.settings.orderPrefix, year, n, ctx.settings.numberDigits),
          shopId: input.shopId,
          agentId: ctx.user.id,
          deliveryDate: toDbDate(today),
          idempotencyKey: input.idempotencyKey,
          ...common,
          items: { create: built.lines },
        },
      });
      orderId = o.id;
    }

    // Stock leaves my car only — never more than the car holds
    const costTotal = await consumeForItems(tx, ctx, { id: orderId, shopId: input.shopId }, undefined, [carOf(ctx.user.id)]);
    await tx.order.update({ where: { id: orderId }, data: { costTotal } });

    const paidNow = await payNow(tx, ctx, input.shopId, input.payment, 'Sotishda');
    await reallocateShop(tx, input.shopId);

    const n = await nextNumber(tx, 'WAYBILL', year);
    const number = formatDocNumber(ctx.settings.waybillPrefix, year, n, ctx.settings.numberDigits);
    const docId = await makeWaybill(tx, ctx, orderId, number, 0, null, paidNow);

    let returnDocId: number | null = null;
    let returnTotal = 0;
    if (input.returns?.length) {
      const r = await createReturnInTx(tx, ctx, { shopId: input.shopId, lines: input.returns, reason: input.returnReason ?? null }, carOf(ctx.user.id));
      returnDocId = r.docId;
      returnTotal = r.ret.total;
    }

    const visit = await tx.visit.create({ data: { shopId: input.shopId, userId: ctx.user.id, result: 'ORDERED', lat: input.pos?.lat, lng: input.pos?.lng, visitedAt: ctx.now() } });
    const item = await itemForShop(tx, ctx.settings, ctx.user, input.shopId, today);
    if (item) await setItemStatus(tx, item.id, input.orderId ? 'DELIVERED' : 'SOLD', { orderId, visitId: visit.id, at: ctx.now() });

    const delivered = await tx.order.count({ where: { shopId: input.shopId, status: 'DELIVERED', isOpening: false } });
    if (shop.status === 'LEAD' || shop.status === 'SAMPLE') await tx.shop.update({ where: { id: shop.id }, data: { status: 'ORDERED' } });
    else if (shop.status === 'ORDERED' && delivered >= 3) await tx.shop.update({ where: { id: shop.id }, data: { status: 'REGULAR' } });

    const balance = (await shopBalances(tx, today, [input.shopId])).get(input.shopId)!.balance;
    await audit(tx, ctx.user.id, 'sell', 'order', orderId, undefined, { waybill: number, total: built.total, paidNow, returnTotal, lines: built.lines });
    return { orderId, number, total: built.total, paidNow, returnTotal, balance, docId, returnDocId, shopName: shop.name };
  });

  if (!result.duplicate) {
    const caption = `✅ Sotildi: <b>${esc(result.shopName)}</b> · ${result.number}\nJami: ${formatMoney(result.total)}${result.paidNow ? `\nOldim: ${formatMoney(result.paidNow)}` : ''}\nQarz: ${formatMoney(Math.max(0, result.balance))}`;
    const buttons = [[{ text: t('bot.open'), app: `o_${result.orderId}` }]];
    await sendDocumentToChat(ctx, result.docId, ctx.user.telegramId, caption, buttons);
    if (result.returnDocId) await sendDocumentToChat(ctx, result.returnDocId, ctx.user.telegramId, `↩️ Qaytarish: ${esc(result.shopName)} · ${formatMoney(result.returnTotal)}`);
    if (!isOwner(ctx.user)) await notifyOwners(ctx, `👤 ${esc(ctx.user.name)}: ${caption}`, buttons);
  }
  return result;
}

/** "Buyurtma yo'q" / "Yopiq edi" from the Sotish screen — logs a visit, may still collect a payment. */
export async function noSale(ctx: Ctx, input: { shopId: number; kind: 'NO_ORDER' | 'CLOSED'; reason: string | null; payment?: SellInput['payment']; idempotencyKey: string; pos?: Pos }) {
  const today = localDate(ctx.now());
  return once(ctx, input.idempotencyKey, 'nosale', async (tx) => {
    const paidNow = await payNow(tx, ctx, input.shopId, input.payment, "Tashrifda (sotuvsiz)");
    if (paidNow) await reallocateShop(tx, input.shopId);
    const visit = await tx.visit.create({ data: { shopId: input.shopId, userId: ctx.user.id, result: input.kind, reason: input.reason, note: input.reason, lat: input.pos?.lat, lng: input.pos?.lng, visitedAt: ctx.now() } });
    const item = await itemForShop(tx, ctx.settings, ctx.user, input.shopId, today);
    if (item) await setItemStatus(tx, item.id, input.kind, { reason: input.reason, visitId: visit.id, at: ctx.now() });
    return { ok: true, paidNow };
  });
}

/** Default delivery day for pre-orders: the coming Friday (setting), moved past days off. */
export async function preorderDate(ctx: Ctx) {
  return workingDayOnOrAfter(ctx.db, ctx.settings, nextWeekday(localDate(ctx.now()), ctx.settings.preorderWeekday));
}

/**
 * "Keyinroq yetkazish": a confirmed order for a later day. It reserves warehouse stock and adds the
 * shop to that day's checklist. Today's row is marked visited.
 */
export async function preorder(ctx: Ctx, input: { shopId: number; lines: LineInput[]; discount?: number; comment?: string | null; deliveryDate?: string; idempotencyKey: string; force?: boolean; pos?: Pos }) {
  const date = input.deliveryDate ?? (await preorderDate(ctx));
  const r = await createOrder(ctx, { shopId: input.shopId, lines: input.lines, discount: input.discount, comment: input.comment, deliveryDate: date, confirm: true, idempotencyKey: input.idempotencyKey, force: input.force });
  if ('confirmError' in r && r.confirmError) return r;
  const today = localDate(ctx.now());
  await inTx(ctx.db, async (tx) => {
    // That day's list may already exist (e.g. tomorrow after the scheduler ran) — add the shop there
    const later = await tx.checklist.findUnique({ where: { userId_date: { userId: ctx.user.id, date: toDbDate(date) } } });
    if (later && !later.closedAt) {
      await tx.checklistItem.upsert({
        where: { checklistId_shopId: { checklistId: later.id, shopId: input.shopId } },
        create: { checklistId: later.id, shopId: input.shopId, source: 'PREORDER', orderId: r.id },
        update: { source: 'PREORDER', orderId: r.id },
      });
    }
    if (date > today) {
      const visit = await tx.visit.create({ data: { shopId: input.shopId, userId: ctx.user.id, result: 'ORDERED', reason: 'Oldindan buyurtma', lat: input.pos?.lat, lng: input.pos?.lng, visitedAt: ctx.now() } });
      const item = await itemForShop(tx, ctx.settings, ctx.user, input.shopId, today);
      if (item && item.status === 'PENDING') await setItemStatus(tx, item.id, 'SOLD', { reason: `Buyurtma olindi: ${date}`, orderId: r.id, visitId: visit.id, at: ctx.now() });
    }
  });
  return { ...r, deliveryDate: date };
}

/** Everything the Sotish screen needs in one call. */
export async function sellForm(ctx: Ctx, shopId: number, orderId?: number) {
  const today = localDate(ctx.now());
  const [shop, products, prices, lastOrder, balance, warnings, pre, preDate] = await Promise.all([
    ctx.db.shop.findUniqueOrThrow({ where: { id: shopId }, select: { id: true, name: true, address: true, phones: true, creditLimit: true, notes: true } }),
    ctx.db.product.findMany({ where: { archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { flavour: 'asc' }] }),
    pricesForShop(ctx.db, shopId, ctx.now()),
    ctx.db.order.findFirst({ where: { shopId, status: 'DELIVERED', isOpening: false }, orderBy: { deliveredAt: 'desc' }, include: { items: true } }),
    shopBalances(ctx.db, today, [shopId]).then((m) => m.get(shopId)!),
    inTx(ctx.db, (tx) => creditWarnings(tx, ctx, shopId, 0, orderId)),
    orderId ? ctx.db.order.findFirst({ where: { id: orderId, shopId }, include: { items: true } }) : null,
    preorderDate(ctx),
  ]);
  const ids = products.map((p) => p.id);
  const car = await placeLevels(ctx.db, ids, carOf(ctx.user.id));
  const lastQty = new Map<number, number>();
  for (const i of lastOrder?.items ?? []) if (!i.isBonus) lastQty.set(i.productId, (lastQty.get(i.productId) ?? 0) + i.qtyCans);
  const sorted = [...products].sort((a, b) => (lastQty.get(b.id) ?? 0) - (lastQty.get(a.id) ?? 0));
  return {
    shop,
    balance,
    warnings,
    canOverride: isOwner(ctx.user),
    maxDiscountBp: isOwner(ctx.user) ? null : ctx.settings.agentMaxDiscountBp,
    preorderDate: preDate,
    lastOrder: lastOrder ? { number: lastOrder.number, date: lastOrder.deliveredAt } : null,
    preorder: pre && (pre.status === 'CONFIRMED' || pre.status === 'IN_TRANSIT')
      ? { id: pre.id, number: pre.number, discount: pre.discount, comment: pre.comment, lines: pre.items.map((i) => ({ productId: i.productId, qtyCans: i.qtyCans, isBonus: i.isBonus, pricePerPack: i.pricePerPack, pricePerCan: i.pricePerCan })) }
      : null,
    products: sorted.map((p) => {
      const pr = prices.get(p.id)!;
      return {
        id: p.id,
        name: p.name,
        flavour: p.flavour,
        packSize: p.packSize,
        photoUrl: fileUrl(p.photoFileId, 7 * 86400),
        perPack: pr.perPack,
        perCan: pr.perCan,
        minPerPack: pr.minPerPack,
        minPerCan: pr.minPerCan,
        inCar: car.get(p.id) ?? 0,
        lastQty: lastQty.get(p.id) ?? 0,
      };
    }),
  };
}

