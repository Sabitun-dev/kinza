import type { DbOrTx } from '../core/db.ts';
import { percentOf } from '../shared/money.ts';
import { defaultCanPrice } from '../shared/qty.ts';

export interface UnitPrice {
  perPack: number;
  perCan: number;
}

export type PriceSource = 'shop' | 'group' | 'default' | 'none';

export interface ResolvedPrice extends UnitPrice {
  source: PriceSource;
  minPerPack: number;
  minPerCan: number;
}

/**
 * Fixed order: the shop's special price → the shop's price group → the product default price.
 */
export function pickPrice(shop: UnitPrice | null | undefined, group: UnitPrice | null | undefined, def: UnitPrice | null | undefined): UnitPrice & { source: PriceSource } {
  if (shop) return { ...shop, source: 'shop' };
  if (group) return { ...group, source: 'group' };
  if (def) return { ...def, source: 'default' };
  return { perPack: 0, perCan: 0, source: 'none' };
}

/** Current price per product and group (newest validFrom <= now). key "productId:groupId|default" */
export async function currentPriceTable(db: DbOrTx, now = new Date()) {
  const rows = await db.productPrice.findMany({
    where: { validFrom: { lte: now } },
    orderBy: [{ validFrom: 'desc' }, { id: 'desc' }],
  });
  const table = new Map<string, UnitPrice & { validFrom: Date }>();
  for (const r of rows) {
    const key = `${r.productId}:${r.priceGroupId ?? 'default'}`;
    if (!table.has(key)) table.set(key, { perPack: r.perPack, perCan: r.perCan, validFrom: r.validFrom });
  }
  return table;
}

/** Prices for every active product for one shop (or the default list when shopId is null). */
export async function pricesForShop(db: DbOrTx, shopId: number | null, now = new Date()): Promise<Map<number, ResolvedPrice>> {
  const [products, table, shop] = await Promise.all([
    db.product.findMany({ where: { archivedAt: null } }),
    currentPriceTable(db, now),
    shopId ? db.shop.findUnique({ where: { id: shopId }, include: { shopPrices: { where: { archivedAt: null } } } }) : null,
  ]);
  const special = new Map(shop?.shopPrices.map((p) => [p.productId, { perPack: p.perPack, perCan: p.perCan }]) ?? []);
  const out = new Map<number, ResolvedPrice>();
  for (const p of products) {
    const group = shop?.priceGroupId ? table.get(`${p.id}:${shop.priceGroupId}`) : undefined;
    const def = table.get(`${p.id}:default`);
    const picked = pickPrice(special.get(p.id), group, def);
    out.set(p.id, {
      perPack: picked.perPack,
      perCan: picked.perCan,
      source: picked.source,
      minPerPack: p.minPricePerPack,
      minPerCan: p.minPricePerCan || defaultCanPrice(p.minPricePerPack, p.packSize),
    });
  }
  return out;
}

export interface LimitInput {
  /** The resolved (base) price for the line. */
  base: UnitPrice;
  /** The price typed on the order line. */
  price: UnitPrice;
  min: UnitPrice;
  maxDiscountBp: number;
}

/**
 * Agent price limits: at most maxDiscountBp below the base price, and never below the minimum.
 * Returns an error text (Uzbek) or null when the price is allowed. The owner has no limit.
 */
export function checkAgentPrice({ base, price, min, maxDiscountBp }: LimitInput): string | null {
  const floorPack = Math.max(min.perPack, base.perPack - percentOf(base.perPack, maxDiscountBp));
  const floorCan = Math.max(min.perCan, base.perCan - percentOf(base.perCan, maxDiscountBp));
  if (price.perPack < floorPack) return `Blok narxi ${floorPack} so'mdan past bo'lmasin`;
  if (price.perCan < floorCan) return `Dona narxi ${floorCan} so'mdan past bo'lmasin`;
  return null;
}

/** Whole-order discount limit for agents (includes the value of bonus goods). */
export function checkAgentOrderDiscount(baseTotal: number, finalTotal: number, maxDiscountBp: number): string | null {
  if (baseTotal <= 0) return null;
  const maxDiscount = percentOf(baseTotal, maxDiscountBp);
  if (baseTotal - finalTotal > maxDiscount) {
    return `Agent chegirmasi ${maxDiscountBp / 100}% dan oshmasin (eng ko'pi ${maxDiscount} so'm)`;
  }
  return null;
}
