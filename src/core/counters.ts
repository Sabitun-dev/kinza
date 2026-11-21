import type { Tx } from './db.ts';

/**
 * Next number for a counter, e.g. ("WAYBILL", 2026) → 17.
 * Gap-free and safe under parallel requests: the row is created if missing, then incremented
 * with one atomic UPDATE … RETURNING that locks the row until the transaction ends.
 * If the transaction rolls back, the increment rolls back too, so no number is skipped.
 */
export async function nextNumber(tx: Tx, series: string, year: number): Promise<number> {
  const key = `${series}:${year}`;
  await tx.$executeRaw`INSERT INTO "counters" ("key", "value") VALUES (${key}, 0) ON CONFLICT ("key") DO NOTHING`;
  const rows = await tx.$queryRaw<{ value: number }[]>`
    UPDATE "counters" SET "value" = "value" + 1 WHERE "key" = ${key} RETURNING "value"`;
  return Number(rows[0].value);
}

export function formatDocNumber(prefix: string, year: number, n: number, digits = 4): string {
  return `${prefix}-${year}-${String(n).padStart(digits, '0')}`;
}
