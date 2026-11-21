import type { AuthUser, Ctx } from './context.ts';
import { forbidden, notFound } from './errors.ts';
import type { Role } from '../generated/prisma/enums.ts';

export const isOwner = (u: AuthUser) => u.role === 'OWNER';

export function requireRole(u: AuthUser, ...roles: Role[]) {
  if (!roles.includes(u.role)) throw forbidden();
}

/** Prisma "where" that limits shops to what this user may see. */
export function shopScope(u: AuthUser) {
  if (u.role === 'OWNER') return {};
  if (u.role === 'AGENT') return { agentId: u.id };
  // Driver: shops that have an order assigned to them
  return { orders: { some: { driverId: u.id } } };
}

/** Prisma "where" that limits orders to what this user may see. */
export function orderScope(u: AuthUser) {
  if (u.role === 'OWNER') return {};
  if (u.role === 'AGENT') return { OR: [{ agentId: u.id }, { shop: { agentId: u.id } }] };
  return { driverId: u.id };
}

export async function assertShopAccess(ctx: Ctx, shopId: number) {
  const shop = await ctx.db.shop.findFirst({ where: { id: shopId, ...shopScope(ctx.user) }, select: { id: true } });
  if (!shop) throw notFound("Do'kon topilmadi");
}

export async function assertOrderAccess(ctx: Ctx, orderId: number) {
  const order = await ctx.db.order.findFirst({ where: { id: orderId, ...orderScope(ctx.user) }, select: { id: true } });
  if (!order) throw notFound('Buyurtma topilmadi');
}

// Fields that reveal buying prices, cost or profit. Removed from every response to non-owners.
const COST_KEYS = new Set([
  'buyPricePerPack',
  'costPerCan',
  'costTotal',
  'landedCostPerCan',
  'landedPerPack',
  'grossProfit',
  'netProfit',
  'profit',
  'expectedProfit',
  'expectedCost',
  'margin',
  'cost',
  'invoiceAmount',
  'supplierBalance',
  'expenses',
  'stockValue',
]);

// Selling-price fields a driver does not need (they only see the amount to collect).
const PRICE_KEYS = new Set([
  'pricePerPack',
  'pricePerCan',
  'basePerPack',
  'basePerCan',
  'perPack',
  'perCan',
  'minPricePerPack',
  'minPricePerCan',
  'lineTotal',
  'subtotal',
  'discount',
  'prices',
]);

/** Deep-copies data without the fields this role must not see. Applied to every API response. */
export function sanitizeFor(role: Role, data: unknown): unknown {
  if (role === 'OWNER') return data;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (COST_KEYS.has(k)) continue;
        if (role === 'DRIVER' && PRICE_KEYS.has(k)) continue;
        out[k] = strip(x);
      }
      return out;
    }
    return v;
  };
  return strip(data);
}

export const SANITIZE_KEYS = { COST_KEYS, PRICE_KEYS };
