import { describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/db.ts';
import { nextNumber } from '../src/core/counters.ts';

describe('database', () => {
  it('runs migrations and numbers documents without gaps', async () => {
    const db = await createTestDb();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => db.$transaction((tx) => nextNumber(tx, 'WAYBILL', 2026))),
    );
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // A rolled-back transaction does not burn a number
    await expect(
      db.$transaction(async (tx) => {
        await nextNumber(tx, 'WAYBILL', 2026);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.$transaction((tx) => nextNumber(tx, 'WAYBILL', 2026))).toBe(21);
  });
});
