import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.ts';
import { addShop } from './helpers/fixtures.ts';
import { autoCarryOver, isShopDue } from '../src/checklist/checklist.ts';
import { getSettings } from '../src/core/settings.ts';
import { addDays, isoWeek, weekParityOf } from '../src/shared/dates.ts';

// Monday 23 Nov 2026 (ISO week 48 → EVEN), Tashkent time
const MON = '2026-11-23';
const at = (day: string, hhmm = '09:00') => new Date(`${day}T${hhmm}:00+05:00`);

async function world() {
  let clock = at(MON);
  const t = await createTestApp({ now: () => clock });
  const setDay = (day: string, hhmm = '09:00') => (clock = at(day, hhmm));
  const a = (await t.owner.post('/api/districts', { name: 'A', routeDay: 1 })).data.id;
  const b = (await t.owner.post('/api/districts', { name: 'B', routeDay: 2 })).data.id;
  const a1 = (await t.owner.post('/api/districts', { name: 'A1', routeDay: 1, weekParity: 'ODD' })).data.id;
  return { ...t, setDay, a, b, a1 };
}
const names = (r: any) => r.data.items.map((i: any) => i.shop.name).sort();

describe('due rules', () => {
  it('ISO week parity', () => {
    expect(isoWeek(MON)).toBe(48);
    expect(weekParityOf(MON)).toBe('EVEN');
    expect(weekParityOf(addDays(MON, 7))).toBe('ODD');
  });
  it('weekly, every 2 weeks by shop, every 2 weeks by area', () => {
    const area = { routeDay: 1, weekParity: null };
    expect(isShopDue({ frequency: 'WEEKLY', weekParity: null, district: area }, MON)).toBe(true);
    expect(isShopDue({ frequency: 'WEEKLY', weekParity: null, district: area }, addDays(MON, 1))).toBe(false);
    expect(isShopDue({ frequency: 'BIWEEKLY', weekParity: 'EVEN', district: area }, MON)).toBe(true);
    expect(isShopDue({ frequency: 'BIWEEKLY', weekParity: 'EVEN', district: area }, addDays(MON, 7))).toBe(false);
    expect(isShopDue({ frequency: 'WEEKLY', weekParity: null, district: { routeDay: 1, weekParity: 'ODD' } }, MON)).toBe(false);
    expect(isShopDue({ frequency: 'WEEKLY', weekParity: null, district: { routeDay: 1, weekParity: 'ODD' } }, addDays(MON, 7))).toBe(true);
  });
});

describe('daily checklist', () => {
  it('contains weekly and 2-week shops due today, and is a stored snapshot', async () => {
    const t = await world();
    await addShop(t, 'Haftalik', { districtId: t.a });
    await addShop(t, 'Juft hafta', { districtId: t.a, frequency: 'BIWEEKLY', weekParity: 'EVEN' });
    await addShop(t, 'Toq hafta', { districtId: t.a, frequency: 'BIWEEKLY', weekParity: 'ODD' });
    await addShop(t, 'A1 hudud', { districtId: t.a1 });
    await addShop(t, 'Seshanba', { districtId: t.b });
    const mon = await t.owner.get('/api/checklist');
    expect(names(mon)).toEqual(['Haftalik', 'Juft hafta']);
    expect(mon.data.areas).toEqual(['A']);
    t.setDay(addDays(MON, 7));
    expect(names(await t.owner.get('/api/checklist'))).toEqual(['A1 hudud', 'Haftalik', 'Toq hafta']);
    // Snapshot: moving a shop to another area does not change an existing day
    t.setDay(MON, '15:00');
    const id = (await t.owner.get('/api/shops')).data.shops.find((s: any) => s.name === 'Haftalik').id;
    await t.owner.patch(`/api/shops/${id}`, { districtId: t.b });
    expect(names(await t.owner.get('/api/checklist'))).toEqual(['Haftalik', 'Juft hafta']);
  });

  it('a shop added to today\'s area during the day appears with "Yangi"', async () => {
    const t = await world();
    await addShop(t, 'Eski', { districtId: t.a });
    await t.owner.get('/api/checklist');
    await addShop(t, 'Yangi do‘kon', { districtId: t.a });
    const r = await t.owner.get('/api/checklist');
    expect(r.data.items.find((i: any) => i.shop.name === 'Yangi do‘kon').source).toBe('NEW');
  });

  it('holidays and Sunday roll shops over to the next working day', async () => {
    const t = await world();
    await addShop(t, 'Dushanba do‘koni', { districtId: t.a });
    await t.owner.post('/api/holidays', { date: MON, note: 'Bayram' });
    expect((await t.owner.get('/api/checklist')).data.dayOff).toBe(true);
    t.setDay(addDays(MON, 1));
    expect(names(await t.owner.get('/api/checklist'))).toEqual(['Dushanba do‘koni']);
    // Sunday 29 Nov → Monday 30 Nov anyway (Sunday is the weekly day off)
    expect((await t.owner.get(`/api/checklist?date=${addDays(MON, 6)}`)).data.dayOff).toBe(true);
  });

  it('23:00 carries ⏳ shops to the next working day; twice in a row is counted', async () => {
    const t = await world();
    await addShop(t, 'Qolgan', { districtId: t.a });
    await addShop(t, 'Sotilgan', { districtId: t.a });
    const mon = await t.owner.get('/api/checklist');
    const sold = mon.data.items.find((i: any) => i.shop.name === 'Sotilgan');
    await t.owner.post(`/api/checklist/items/${sold.id}/no-order`, { reason: "javon to'la" });
    const s = await getSettings(t.db);
    expect(await autoCarryOver(t.db, s, MON)).toBe(1);
    t.setDay(addDays(MON, 1));
    const tue = await t.owner.get('/api/checklist');
    const carried = tue.data.items.find((i: any) => i.shop.name === 'Qolgan');
    expect(carried.source).toBe('CARRY');
    expect(carried.carryCount).toBe(1);
    expect(names(tue)).toEqual(['Qolgan']);
    await autoCarryOver(t.db, s, addDays(MON, 1));
    t.setDay(addDays(MON, 2));
    const wed = await t.owner.get('/api/checklist');
    expect(wed.data.items[0].carryCount).toBe(2);
  });

  it('Kun yakuni cannot close while shops are ⏳; decisions move them', async () => {
    const t = await world();
    await addShop(t, 'Bir', { districtId: t.a });
    await addShop(t, 'Ikki', { districtId: t.a });
    await addShop(t, 'Uch', { districtId: t.a });
    const mon = (await t.owner.get('/api/checklist')).data;
    const item = (n: string) => mon.items.find((i: any) => i.shop.name === n).id;
    const fail = await t.owner.post(`/api/checklist/${mon.id}/close`, { decisions: [] });
    expect(fail.status).toBe(409);
    expect(fail.data.error).toContain('Bir');
    const ok = await t.owner.post(`/api/checklist/${mon.id}/close`, {
      decisions: [
        { itemId: item('Bir'), choice: 'tomorrow' },
        { itemId: item('Ikki'), choice: 'friday' },
        { itemId: item('Uch'), choice: 'visited' },
      ],
    });
    expect(ok.status).toBe(200);
    t.setDay(addDays(MON, 1));
    expect(names(await t.owner.get('/api/checklist'))).toEqual(['Bir']);
    t.setDay(addDays(MON, 4));
    expect(names(await t.owner.get('/api/checklist'))).toEqual(['Ikki']);
  });

  it('"Boshqa kunga" needs a reason', async () => {
    const t = await world();
    await addShop(t, 'Bir', { districtId: t.a });
    const mon = (await t.owner.get('/api/checklist')).data;
    expect((await t.owner.post(`/api/checklist/items/${mon.items[0].id}/move`, { date: addDays(MON, 2), reason: '' })).status).toBe(400);
    expect((await t.owner.post(`/api/checklist/items/${mon.items[0].id}/move`, { date: addDays(MON, 2), reason: 'Egasi yo‘q' })).data.movedTo).toBe(addDays(MON, 2));
  });

  it('a shop cannot be saved without area, frequency or map pin', async () => {
    const t = await world();
    const r = await t.owner.post('/api/shops', { name: 'Chala', districtId: t.a });
    expect(r.status).toBe(400);
    expect(r.data.error).toContain('joylashuv');
    const r2 = await t.owner.post('/api/shops', { name: 'Chala', lat: 41, lng: 71 });
    expect(r2.data.error).toContain('hudud');
    expect((await t.owner.post('/api/shops', { name: 'Nofaol', status: 'INACTIVE' })).status).toBe(200);
    // Old shops missing data are listed as problems
    await t.db.shop.create({ data: { name: 'Eski chala', status: 'REGULAR' } });
    const c = await t.owner.get('/api/checklist');
    expect(c.data.problems.map((p: any) => p.name)).toEqual(['Eski chala']);
  });

  it('coverage: % of due shops visited and who was missed', async () => {
    const t = await world();
    for (const n of ['Bir', 'Ikki', 'Uch', 'To‘rt']) await addShop(t, n, { districtId: t.a });
    const mon = (await t.owner.get('/api/checklist')).data;
    const id = (n: string) => mon.items.find((i: any) => i.shop.name === n).id;
    await t.owner.post(`/api/checklist/items/${id('Bir')}/no-order`, { reason: "pul yo'q" });
    await t.owner.post(`/api/checklist/items/${id('Ikki')}/no-order`, { reason: "javon to'la" });
    await t.owner.post(`/api/checklist/items/${id('Uch')}/closed`, {});
    const cov = (await t.owner.get(`/api/coverage?from=${MON}&to=${MON}`)).data;
    expect(cov.due).toBe(4);
    expect(cov.visited).toBe(2);
    expect(cov.percent).toBe(50);
    expect(cov.missed.map((m: any) => m.name).sort()).toEqual(['To‘rt', 'Uch']);
  });

  it('prints the list PDF to my chat', async () => {
    const t = await world();
    await addShop(t, 'Bir', { districtId: t.a });
    const mon = (await t.owner.get('/api/checklist')).data;
    await t.owner.post(`/api/checklist/${mon.id}/print`);
    expect(t.notifier.sent.at(-1)!.file!.name).toBe(`Royxat-${MON}.pdf`);
  });
});
