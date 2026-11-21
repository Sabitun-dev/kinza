import { describe, expect, it } from 'vitest';
import { checkAgentOrderDiscount, checkAgentPrice, pickPrice } from '../src/domain/pricing.ts';
import { createTestApp } from './helpers/app.ts';
import { addProduct, addShop } from './helpers/fixtures.ts';

describe('price resolution', () => {
  const shop = { perPack: 110_000, perCan: 4_700 };
  const group = { perPack: 115_000, perCan: 4_900 };
  const def = { perPack: 120_000, perCan: 5_000 };

  it('shop special price → price group → default', () => {
    expect(pickPrice(shop, group, def)).toMatchObject({ perPack: 110_000, source: 'shop' });
    expect(pickPrice(null, group, def)).toMatchObject({ perPack: 115_000, source: 'group' });
    expect(pickPrice(null, null, def)).toMatchObject({ perPack: 120_000, source: 'default' });
    expect(pickPrice(null, null, null)).toMatchObject({ perPack: 0, source: 'none' });
  });

  it('works end to end through the API', async () => {
    const t = await createTestApp();
    const groups = (await t.owner.get('/api/price-groups')).data.groups;
    const superId = groups.find((g: any) => g.name === 'Supermarket').id;
    const limon = await addProduct(t, 'Limon', 120_000);
    await t.owner.patch(`/api/products/${limon}`, { groupPrices: [{ groupId: superId, perPack: 115_000 }] });
    const plain = await addShop(t, 'Oddiy');
    const sm = await addShop(t, 'Korzinka', { priceGroupId: superId });
    const special = await addShop(t, 'Maxsus', { priceGroupId: superId });
    await t.owner.put(`/api/shops/${special}/prices`, { prices: [{ productId: limon, perPack: 110_000 }] });

    const p = async (shopId: number) => (await t.owner.get(`/api/pricing?shopId=${shopId}`)).data.prices[limon];
    expect(await p(plain)).toMatchObject({ perPack: 120_000, perCan: 5_000, source: 'default' });
    expect(await p(sm)).toMatchObject({ perPack: 115_000, source: 'group' });
    expect(await p(special)).toMatchObject({ perPack: 110_000, source: 'shop' });

    // History is kept
    await t.owner.patch(`/api/products/${limon}`, { price: { perPack: 125_000 } });
    const detail = await t.owner.get(`/api/products/${limon}`);
    expect(detail.data.priceHistory.length).toBe(3);
    expect(await p(plain)).toMatchObject({ perPack: 125_000 });
  });
});

describe('agent price limits', () => {
  const base = { perPack: 120_000, perCan: 5_000 };
  const min = { perPack: 112_000, perCan: 4_700 };
  it('allows up to 5% discount', () => {
    expect(checkAgentPrice({ base, price: { perPack: 114_000, perCan: 4_750 }, min, maxDiscountBp: 500 })).toBeNull();
  });
  it('blocks more than 5%', () => {
    expect(checkAgentPrice({ base, price: { perPack: 113_000, perCan: 5_000 }, min, maxDiscountBp: 500 })).toContain('114000');
  });
  it('never below the minimum price', () => {
    expect(checkAgentPrice({ base, price: { perPack: 113_000, perCan: 5_000 }, min: { perPack: 116_000, perCan: 0 }, maxDiscountBp: 500 })).toContain('116000');
  });
  it('limits the whole-order discount', () => {
    expect(checkAgentOrderDiscount(1_000_000, 950_000, 500)).toBeNull();
    expect(checkAgentOrderDiscount(1_000_000, 940_000, 500)).not.toBeNull();
  });
});

describe('products and stock visibility', () => {
  it('agent never sees buying price; driver sees no prices', async () => {
    const t = await createTestApp();
    await addProduct(t, 'Limon');
    const agent = await t.addUser(2001, 'AGENT');
    const driver = await t.addUser(3001, 'DRIVER');
    const o = (await t.owner.get('/api/products')).data.products[0];
    expect(o.buyPricePerPack).toBe(90_000);
    const a = (await agent.get('/api/products')).data.products[0];
    expect(a.buyPricePerPack).toBeUndefined();
    expect(a.stock.stockValue).toBeUndefined();
    expect(a.prices.perPack).toBe(120_000);
    const d = (await driver.get('/api/products')).data.products[0];
    expect(d.prices).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('120000');
    expect((await agent.post('/api/products', { flavour: 'X' })).status).toBe(403);
  });
});
