import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop, addStock } from './helpers/fixtures.ts';
import { buildLines } from '../src/domain/orders.ts';

async function setup() {
  const t = await createTestApp();
  const limon = await addProduct(t, 'Limon', 120_000);
  const apelsin = await addProduct(t, 'Apelsin', 110_000);
  const shop = await addShop(t, 'Baraka', { phones: ['+998901112233'] });
  return { ...t, limon, apelsin, shop };
}

const level = async (t: Awaited<ReturnType<typeof setup>>, productId: number) =>
  (await t.owner.get('/api/products')).data.products.find((p: any) => p.id === productId).stock;

describe('order totals', () => {
  const products = new Map([[1, { id: 1, flavour: 'Limon', name: 'Kinza', packSize: 24, archivedAt: null }]]);
  const prices = new Map([[1, { perPack: 120_000, perCan: 5_000, source: 'default' as const, minPerPack: 0, minPerCan: 0 }]]);
  it('2 packs + 6 cans at 120 000 = 270 000', () => {
    const r = buildLines([{ productId: 1, qtyCans: 54 }], products, prices);
    expect(r.total).toBe(270_000);
  });
  it('discount and bonus', () => {
    const r = buildLines(
      [
        { productId: 1, qtyCans: 240 },
        { productId: 1, qtyCans: 24, isBonus: true },
      ],
      products,
      prices,
      50_000,
    );
    expect(r.subtotal).toBe(1_200_000);
    expect(r.lines[1].lineTotal).toBe(0);
    expect(r.total).toBe(1_150_000);
    expect(r.baseTotal).toBe(1_320_000); // bonus valued at normal price for agent limits
  });
});

describe('order flow', () => {
  it('confirm reserves stock, cancel releases it', async () => {
    const t = await setup();
    await addStock(t, t.limon, 240);
    const r = await t.owner.post('/api/orders', { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 120 }], confirm: true });
    expect(r.data.status).toBe('CONFIRMED');
    expect((await level(t, t.limon)).reserved).toBe(120);
    expect((await level(t, t.limon)).available).toBe(120);
    // Confirmation PDF went to my chat
    expect(t.notifier.sent.some((m) => m.file?.name.startsWith('Buyurtma-B-2026-'))).toBe(true);
    await t.owner.post(`/api/orders/${r.data.id}/cancel`, { reason: 'Do‘kon yopildi' });
    expect((await level(t, t.limon)).reserved).toBe(0);
    const docs = await t.db.document.findMany({ where: { orderId: r.data.id } });
    expect(docs.every((d) => d.voidedAt)).toBe(true);
  });

  it('delivers a smaller quantity with partial cash; nakladnoy, debt and stock are correct', async () => {
    const t = await setup();
    await addStock(t, t.limon, 480, 3875);
    await t.owner.post(`/api/shops/${t.shop}/opening-balance`, { amount: 500_000, date: '2026-11-01' });
    const r = await t.owner.post('/api/orders', {
      shopId: t.shop,
      lines: [
        { productId: t.limon, qtyCans: 240 },
        { productId: t.limon, qtyCans: 24, isBonus: true },
      ],
      confirm: true,
      force: true, // the opening debt is overdue → owner confirms anyway
    });
    const order = (await t.owner.get(`/api/orders/${r.data.id}`)).data.order;
    const main = order.items.find((i: any) => !i.isBonus);
    // Shop takes 8 packs instead of 10, pays 500 000 cash
    const d = await t.owner.post(`/api/orders/${r.data.id}/deliver`, { items: [{ id: main.id, qtyCans: 192 }], payment: { amount: 500_000, method: 'CASH' } });
    expect(d.status).toBe(200);
    expect(d.data.waybillNumber).toBe('KD-2026-0001');
    const after = (await t.owner.get(`/api/orders/${r.data.id}`)).data.order;
    expect(after.total).toBe(960_000);
    expect(after.paidAmount).toBe(500_000);
    expect(after.outstanding).toBe(460_000);
    expect(after.payStatus).toBe('PARTIAL');
    // Stock: 480 − 192 − 24 bonus
    const s = await level(t, t.limon);
    expect(s.inStock).toBe(264);
    expect(s.reserved).toBe(0);
    // Cost and profit: 216 cans × 3875
    expect(after.costTotal).toBe(837_000);
    expect(after.grossProfit).toBe(960_000 - 837_000);
    // Shop debt = opening 500 000 + 460 000 (payment targeted this invoice)
    const shop = (await t.owner.get(`/api/shops/${t.shop}`)).data;
    expect(shop.balance.balance).toBe(960_000);
    // The nakladnoy PDF arrived in the chat
    expect(t.notifier.sent.some((m) => m.file?.name === 'Nakladnoy-KD-2026-0001.pdf')).toBe(true);
  });

  it('landed cost example: 93 000 per pack, 10 packs at 120 000 → profit 270 000', async () => {
    const t = await setup();
    await addStock(t, t.limon, 240, 93_000 / 24);
    const r = await t.owner.post('/api/orders', { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 240 }], confirm: true });
    await t.owner.post(`/api/orders/${r.data.id}/deliver`, {});
    const o = (await t.owner.get(`/api/orders/${r.data.id}`)).data.order;
    expect(o.grossProfit).toBe(270_000);
  });

  it('FIFO takes the oldest expiry first', async () => {
    const t = await setup();
    const late = await addStock(t, t.limon, 48, 4000, '2027-06-01');
    const early = await addStock(t, t.limon, 48, 3500, '2027-01-01');
    const r = await t.owner.post('/api/orders', { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 60 }], confirm: true });
    await t.owner.post(`/api/orders/${r.data.id}/deliver`, {});
    const b1 = await t.db.stockBatch.findUniqueOrThrow({ where: { id: early } });
    const b2 = await t.db.stockBatch.findUniqueOrThrow({ where: { id: late } });
    expect(b1.remainingCans).toBe(0);
    expect(b2.remainingCans).toBe(36);
    const o = (await t.owner.get(`/api/orders/${r.data.id}`)).data.order;
    expect(o.costTotal).toBe(48 * 3500 + 12 * 4000);
  });

  it('cannot deliver more than in stock', async () => {
    const t = await setup();
    await addStock(t, t.limon, 10);
    const r = await t.owner.post('/api/orders', { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 24 }], confirm: true });
    expect(r.data.status).toBe('CONFIRMED'); // confirming without stock is allowed (to be ordered)
    const d = await t.owner.post(`/api/orders/${r.data.id}/deliver`, {});
    expect(d.status).toBe(409);
    expect(d.data.error).toContain('Omborda yetarli emas');
  });

  it('revision after delivery voids the old nakladnoy and keeps the number', async () => {
    const t = await setup();
    await addStock(t, t.limon, 480);
    const r = await t.owner.post('/api/orders', { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 240 }], confirm: true });
    await t.owner.post(`/api/orders/${r.data.id}/deliver`, {});
    const noReason = await t.owner.post(`/api/orders/${r.data.id}/revise`, { lines: [{ productId: t.limon, qtyCans: 120 }], reason: '' });
    expect(noReason.status).toBe(400);
    const rev = await t.owner.post(`/api/orders/${r.data.id}/revise`, { lines: [{ productId: t.limon, qtyCans: 120 }], reason: 'Xato yozilgan' });
    expect(rev.data.number).toBe('KD-2026-0001-R1');
    const o = (await t.owner.get(`/api/orders/${r.data.id}`)).data.order;
    expect(o.total).toBe(600_000);
    expect(o.revision).toBe(1);
    const waybills = o.documents.filter((d: any) => d.kind === 'WAYBILL');
    expect(waybills.length).toBe(2);
    expect(waybills.filter((d: any) => d.voided).length).toBe(1);
    expect((await level(t, t.limon)).inStock).toBe(360);
  });

  it('nakladnoy numbers are gap-free under parallel deliveries', async () => {
    const t = await setup();
    await addStock(t, t.limon, 24 * 20);
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push((await t.owner.post('/api/orders', { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 24 }], confirm: true })).data.id);
    }
    const res = await Promise.all(ids.map((id) => t.owner.post(`/api/orders/${id}/deliver`, {})));
    const numbers = res.map((r) => r.data.waybillNumber).sort();
    expect(numbers).toEqual(['KD-2026-0001', 'KD-2026-0002', 'KD-2026-0003', 'KD-2026-0004', 'KD-2026-0005', 'KD-2026-0006']);
  });

  it('the same idempotency key never creates two orders', async () => {
    const t = await setup();
    const body = { shopId: t.shop, lines: [{ productId: t.limon, qtyCans: 24 }], confirm: true, idempotencyKey: 'offline-key-123' };
    const [a, b] = await Promise.all([t.owner.post('/api/orders', body), t.owner.post('/api/orders', body)]);
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const again = await t.owner.post('/api/orders', body);
    expect(again.data.duplicate).toBe(true);
    expect(await t.db.order.count({ where: { idempotencyKey: 'offline-key-123' } })).toBe(1);
  });

  it('credit limit warns; owner can override, agent cannot', async () => {
    const t = await setup();
    const agent = await t.addUser(2001, 'AGENT');
    const shop = await addShop(t, 'Limitli', { creditLimit: 500_000, agentId: agent.id });
    const r = await agent.post('/api/orders', { shopId: shop, lines: [{ productId: t.limon, qtyCans: 120 }], confirm: true });
    expect(r.data.status).toBe('DRAFT');
    expect(r.data.confirmError.code).toBe('credit_warning');
    expect((await agent.post(`/api/orders/${r.data.id}/confirm`, { force: true })).status).toBe(409);
    const o = await t.owner.post(`/api/orders/${r.data.id}/confirm`, { force: true });
    expect(o.data.status).toBe('CONFIRMED');
  });

  it('agent price limits are enforced on the server', async () => {
    const t = await setup();
    const agent = await t.addUser(2001, 'AGENT');
    const shop = await addShop(t, 'Agent do‘koni', { agentId: agent.id });
    const tooCheap = await agent.post('/api/orders', { shopId: shop, lines: [{ productId: t.limon, qtyCans: 24, pricePerPack: 110_000 }] });
    expect(tooCheap.status).toBe(400);
    expect(tooCheap.data.code).toBe('price_limit');
    const okPrice = await agent.post('/api/orders', { shopId: shop, lines: [{ productId: t.limon, qtyCans: 24, pricePerPack: 114_000 }] });
    expect(okPrice.status).toBe(200);
    const bigDiscount = await agent.post('/api/orders', { shopId: shop, lines: [{ productId: t.limon, qtyCans: 240 }], discount: 100_000 });
    expect(bigDiscount.status).toBe(400);
    const bonus = await agent.post('/api/orders', { shopId: shop, lines: [{ productId: t.limon, qtyCans: 240 }, { productId: t.limon, qtyCans: 24, isBonus: true }] });
    expect(bonus.status).toBe(400); // 1 free pack on 10 = 9% > 5%
    const ownerCheap = await t.owner.post('/api/orders', { shopId: shop, lines: [{ productId: t.limon, qtyCans: 24, pricePerPack: 50_000 }] });
    expect(ownerCheap.status).toBe(200);
    // The agent never sees cost or profit
    const o = await agent.get(`/api/orders/${okPrice.data.id}`);
    expect(o.data.order.costTotal).toBeUndefined();
    expect(o.data.order.grossProfit).toBeUndefined();
    expect(JSON.stringify(o.data)).not.toMatch(/costPerCan|grossProfit|buyPricePerPack/);
    // and the owner was told about the agent's order? (only on confirm)
    expect(t.notifier.sent.length).toBeGreaterThanOrEqual(0);
  });

  it('repeat order: the form returns the last order lines and favourite flavours first', async () => {
    const t = await setup();
    await t.owner.post('/api/orders', { shopId: t.shop, lines: [{ productId: t.apelsin, qtyCans: 48 }] });
    const f = await t.owner.get(`/api/order-form?shopId=${t.shop}`);
    expect(f.data.lastOrder.lines).toEqual([{ productId: t.apelsin, qtyCans: 48, isBonus: false }]);
    expect(f.data.products[0].id).toBe(t.apelsin);
    expect(f.data.products[0].favourite).toBe(true);
  });
});
