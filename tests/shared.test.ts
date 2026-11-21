import { describe, expect, it } from 'vitest';
import { formatMoney, parseMoney } from '../src/shared/money.ts';
import { formatQty, priceFor, splitCans, toCans } from '../src/shared/qty.ts';
import { numberToUzWords, moneyToUzWords } from '../src/shared/uzwords.ts';
import { addWorkingDays, localDate, localTime, weekday } from '../src/shared/dates.ts';

describe('money', () => {
  it('formats with spaces', () => {
    expect(formatMoney(1250000)).toBe("1 250 000 so'm");
    expect(formatMoney(0)).toBe("0 so'm");
    expect(formatMoney(-5000)).toBe("-5 000 so'm");
    expect(parseMoney('1 250 000')).toBe(1250000);
  });
});

describe('packs and cans', () => {
  it('"2 blok 6 dona" = 54 cans', () => {
    expect(toCans(2, 6, 24)).toBe(54);
    expect(splitCans(54, 24)).toEqual({ packs: 2, cans: 6 });
    expect(formatQty(246, 24)).toBe('10 blok + 6 dona');
    expect(formatQty(240, 24)).toBe('10 blok');
    expect(formatQty(6, 24)).toBe('6 dona');
  });
  it('2 packs + 6 cans at 120 000 per pack = 270 000', () => {
    expect(priceFor(54, 24, 120_000, 5_000)).toBe(270_000);
  });
});

describe('Uzbek words', () => {
  it.each([
    [0, 'Nol'],
    [5, 'Besh'],
    [11, "O'n bir"],
    [100, 'Bir yuz'],
    [120000, 'Bir yuz yigirma ming'],
    [1250000, 'Bir million ikki yuz ellik ming'],
    [2004017, "Ikki million to'rt ming o'n yetti"],
    [3_000_000_000, 'Uch milliard'],
  ])('%i → %s', (n, words) => {
    expect(numberToUzWords(n)).toBe(words);
  });
  it('adds so\'m', () => {
    expect(moneyToUzWords(270000)).toBe("Ikki yuz yetmish ming so'm");
  });
});

describe('Tashkent dates', () => {
  it('converts UTC to Tashkent', () => {
    const d = new Date('2026-11-20T20:30:00Z'); // 01:30 next day in Tashkent
    expect(localDate(d)).toBe('2026-11-21');
    expect(localTime(d)).toBe('01:30');
  });
  it('delivery skips Sundays', () => {
    expect(weekday('2026-11-20')).toBe(5); // Friday
    expect(addWorkingDays('2026-11-20', 2, true)).toBe('2026-11-23'); // Sat, (Sun), Mon
    expect(addWorkingDays('2026-11-20', 2, false)).toBe('2026-11-22');
    expect(addWorkingDays('2026-11-18', 2, true)).toBe('2026-11-20');
  });
});
