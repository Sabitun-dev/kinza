import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop, addStock } from './helpers/fixtures.ts';

async function sold() {
  const t = await createTestApp();
  const limon = await addProduct(t, 'Limon', 120_000);
  const cola = await addProduct(t, 'Cola', 110_000);
  const shop = await addShop(t, 'Baraka');
  await addStock(t, limon, 24 * 20, 93_000 / 24);
  await addStock(t, cola, 24 * 20, 90_000 / 24);
  const sell = async (lines: { productId: number; qtyCans: number }[]) => {
    const o = await t.owner.post('/api/orders', { shopId: shop, lines, confirm: true, force: true });
    await t.owner.post(`/api/orders/${o.data.id}/deliver`, {});
  };
  await sell([{ productId: limon, qtyCans: 240 }]); // 1 200 000, cost 930 000
  await sell([{ productId: cola, qtyCans: 120 }]); // 550 000, cost 450 000
  await t.owner.post('/api/payments', { shopId: shop, amount: 1_000_000, method: 'CASH' });
  const cat = (await t.owner.get('/api/expense-categories')).data.categories[0].id;
  const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  await t.owner.post('/api/expenses', { categoryId: cat, amount: 120_000, date: today, comment: 'Benzin' });
  return { ...t, limon, cola, shop, today };
}

describe('dashboard', () => {
  it('matches a hand count', async () => {
    const t = await sold();
    const d = (await t.owner.get(`/api/dashboard?from=${t.today}&to=${t.today}`)).data;
    expect(d.revenue).toBe(1_750_000);
    expect(d.grossProfit).toBe(1_750_000 - 930_000 - 450_000);
    expect(d.expenses).toBe(120_000);
    expect(d.netProfit).toBe(370_000 - 120_000);
    expect(d.collected).toBe(1_000_000);
    expect(d.packsSold).toBe(15);
    expect(d.orderCount).toBe(2);
    expect(d.avgOrder).toBe(875_000);
    expect(d.debt).toBe(750_000);
    expect(d.topFlavours[0].flavour).toBe('Limon');
    expect(d.series.at(-1).revenue).toBe(1_750_000);
  });

  it('agents cannot open the dashboard or expenses', async () => {
    const t = await sold();
    const agent = await t.addUser(2001, 'AGENT');
    expect((await agent.get('/api/dashboard')).status).toBe(403);
    expect((await agent.get('/api/expenses')).status).toBe(403);
  });
});

describe('exports', () => {
  it('Excel opens and has the rows; CSV has a BOM and ; separator', async () => {
    const t = await sold();
    const r = await t.owner.post('/api/exports', { kind: 'sales', format: 'xlsx', from: t.today, to: t.today });
    expect(r.data.rows).toBe(2);
    const sent = t.notifier.sent.at(-1)!;
    expect(sent.file!.name).toMatch(/\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(sent.file!.data) as never);
    const ws = wb.worksheets[0];
    expect(ws.getRow(3).getCell(3).value).toBe("Do'kon");
    expect(ws.getRow(4).getCell(10).value).toBe(1_200_000);
    for (const kind of ['debts', 'stock', 'payments', 'expenses', 'supplier']) {
      const x = await t.owner.post('/api/exports', { kind, format: 'csv' });
      expect(x.status).toBe(200);
    }
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(t.notifier.sent.find((m) => m.file?.name.startsWith('Xarajatlar'))!.file!.data);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Sana;Turi;Summa;Izoh');
    expect(csv).toContain('120000;Benzin');
  });
});

describe('commission', () => {
  it('percent of collected money', async () => {
    const t = await sold();
    const agent = await t.addUser(2001, 'AGENT');
    await t.owner.patch(`/api/users/${agent.id}`, { commissionMode: 'COLLECTED', commissionBp: 200 });
    await t.owner.patch(`/api/shops/${t.shop}`, { agentId: agent.id });
    await agent.post('/api/payments', { shopId: t.shop, amount: 500_000, method: 'CASH' });
    const s = (await agent.get('/api/commission')).data;
    expect(s.collected).toBe(500_000);
    expect(s.commission).toBe(10_000);
    expect((await agent.get(`/api/commission?userId=1`)).status).toBe(403);
  });
});
