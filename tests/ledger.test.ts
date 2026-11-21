import { describe, expect, it } from 'vitest';
import { allocate } from '../src/domain/ledger.ts';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop, addStock } from './helpers/fixtures.ts';

const d = (s: string) => new Date(s + 'T10:00:00Z');

describe('allocation (pure)', () => {
  it('oldest invoice first: 400k + 600k, pays 700k → first paid, 300k left on second', () => {
    const r = allocate(
      [
        { id: 2, total: 600_000, date: d('2026-11-05') },
        { id: 1, total: 400_000, date: d('2026-11-01') },
      ],
      [{ kind: 'payment', id: 1, amount: 700_000, date: d('2026-11-10'), targetOrderId: null }],
    );
    expect(r.remaining.get(1)).toBe(0);
    expect(r.remaining.get(2)).toBe(300_000);
    expect(r.unallocated).toBe(0);
  });
  it('a chosen invoice is paid first', () => {
    const r = allocate(
      [
        { id: 1, total: 400_000, date: d('2026-11-01') },
        { id: 2, total: 600_000, date: d('2026-11-05') },
      ],
      [{ kind: 'payment', id: 1, amount: 500_000, date: d('2026-11-10'), targetOrderId: 2 }],
    );
    expect(r.remaining.get(2)).toBe(100_000);
    expect(r.remaining.get(1)).toBe(400_000);
  });
  it('overpayment stays as shop credit and covers the next invoice', () => {
    const r1 = allocate([{ id: 1, total: 400_000, date: d('2026-11-01') }], [{ kind: 'payment', id: 1, amount: 500_000, date: d('2026-11-02'), targetOrderId: null }]);
    expect(r1.unallocated).toBe(100_000);
    const r2 = allocate(
      [
        { id: 1, total: 400_000, date: d('2026-11-01') },
        { id: 2, total: 250_000, date: d('2026-11-03') },
      ],
      [{ kind: 'payment', id: 1, amount: 500_000, date: d('2026-11-02'), targetOrderId: null }],
    );
    expect(r2.remaining.get(2)).toBe(150_000);
    expect(r2.unallocated).toBe(0);
  });
});

async function deliveredShop() {
  const t = await createTestApp();
  const limon = await addProduct(t, 'Limon', 120_000);
  const shop = await addShop(t, 'Baraka');
  await addStock(t, limon, 24 * 50, 3875);
  const deliver = async (cans: number) => {
    const o = await t.owner.post('/api/orders', { shopId: shop, lines: [{ productId: limon, qtyCans: cans }], confirm: true, force: true });
    await t.owner.post(`/api/orders/${o.data.id}/deliver`, {});
    return o.data.id as number;
  };
  return { ...t, limon, shop, deliver };
}

describe('payments through the API', () => {
  it('applies to the oldest invoice and keeps overpayment as credit', async () => {
    const t = await deliveredShop();
    const first = await t.deliver(80); // 400 000? 3 packs + 8 cans = 360 000 + 40 000 = 400 000
    const second = await t.deliver(120); // 600 000
    expect((await t.owner.get(`/api/orders/${first}`)).data.order.total).toBe(400_000);
    await t.owner.post('/api/payments', { shopId: t.shop, amount: 700_000, method: 'CASH' });
    expect((await t.owner.get(`/api/orders/${first}`)).data.order.payStatus).toBe('PAID');
    const s = (await t.owner.get(`/api/orders/${second}`)).data.order;
    expect(s.outstanding).toBe(300_000);
    expect(s.payStatus).toBe('PARTIAL');
    const over = await t.owner.post('/api/payments', { shopId: t.shop, amount: 500_000, method: 'CARD' });
    expect(over.data.balance).toBe(-200_000);
    expect(over.data.credit).toBe(200_000);
    // receipt PDF stored
    expect(await t.db.document.count({ where: { kind: 'PAYMENT_RECEIPT' } })).toBe(2);
  });

  it('voiding a payment brings the debt back', async () => {
    const t = await deliveredShop();
    const id = await t.deliver(120);
    const p = await t.owner.post('/api/payments', { shopId: t.shop, amount: 600_000, method: 'CASH' });
    expect((await t.owner.get(`/api/orders/${id}`)).data.order.outstanding).toBe(0);
    await t.owner.post(`/api/payments/${p.data.id}/void`, { reason: 'Xato' });
    expect((await t.owner.get(`/api/orders/${id}`)).data.order.outstanding).toBe(600_000);
  });

  it('debtors with age buckets', async () => {
    const t = await deliveredShop();
    await t.deliver(120);
    await t.owner.post(`/api/shops/${t.shop}/opening-balance`, { amount: 100_000, date: '2026-09-01' });
    const r = await t.owner.get('/api/debtors');
    expect(r.data.rows[0].balance).toBe(700_000);
    expect(r.data.totals.b30).toBe(100_000);
    expect(r.data.totals.b0).toBe(600_000);
    expect(r.data.rows[0].overdue).toBe(100_000);
  });

  it('cash collected by an agent stays in their hands until the owner confirms', async () => {
    const t = await deliveredShop();
    const agent = await t.addUser(2001, 'AGENT');
    await t.owner.patch(`/api/shops/${t.shop}`, { agentId: agent.id });
    await t.deliver(120);
    await agent.post('/api/payments', { shopId: t.shop, amount: 250_000, method: 'CASH' });
    const cash = await t.owner.get('/api/cash');
    expect(cash.data.people).toHaveLength(1);
    expect(cash.data.people[0].total).toBe(250_000);
    expect((await agent.post('/api/cash/handover', { userId: agent.id })).status).toBe(403);
    await t.owner.post('/api/cash/handover', { userId: agent.id });
    expect((await t.owner.get('/api/cash')).data.people).toHaveLength(0);
    // Owner got a message about the agent's payment
    expect(t.notifier.sent.some((m) => m.text?.includes("To'lov"))).toBe(true);
  });
});

describe('returns and reconciliation', () => {
  it('a return reduces the debt; sellable cans go back to stock, damaged to the damaged pool', async () => {
    const t = await deliveredShop();
    const id = await t.deliver(120);
    const before = (await t.owner.get('/api/products')).data.products[0].stock;
    const r = await t.owner.post('/api/returns', {
      shopId: t.shop,
      orderId: id,
      reason: 'Ezilgan',
      lines: [
        { productId: t.limon, qtyCans: 6, condition: 'DAMAGED' },
        { productId: t.limon, qtyCans: 24, condition: 'SELLABLE' },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.data.total).toBe(30 * 5_000);
    expect(r.data.number).toBe('QD-2026-0001');
    expect(r.data.balance).toBe(600_000 - 150_000);
    const after = (await t.owner.get('/api/products')).data.products[0].stock;
    expect(after.inStock).toBe(before.inStock + 24);
    expect(after.damaged).toBe(6);
    const tooMany = await t.owner.post('/api/returns', { shopId: t.shop, orderId: id, lines: [{ productId: t.limon, qtyCans: 100, condition: 'DAMAGED' }] });
    expect(tooMany.status).toBe(400);
  });

  it('akt sverki: opening + deliveries − payments − returns = closing', async () => {
    const t = await deliveredShop();
    await t.owner.post(`/api/shops/${t.shop}/opening-balance`, { amount: 1_000_000, date: '2026-10-01' });
    await t.deliver(120); // 600 000
    await t.owner.post('/api/payments', { shopId: t.shop, amount: 700_000, method: 'CASH' });
    const today = new Date().toISOString().slice(0, 10);
    const r = await t.owner.post(`/api/shops/${t.shop}/reconciliation`, { from: '2026-11-01', to: today });
    expect(r.data.opening).toBe(1_000_000);
    expect(r.data.closing).toBe(900_000);
    expect(r.data.rows).toHaveLength(2);
    expect(t.notifier.sent.some((m) => m.file?.name.startsWith('Akt-sverki-AS-2026-0001'))).toBe(true);
  });
});
