import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '../../src/generated/prisma/client.ts';

const migrationsDir = join(import.meta.dirname, '../../prisma/migrations');

/** A fresh in-memory Postgres with all migrations applied. */
export async function createTestDb(): Promise<PrismaClient> {
  const pg = new PGlite();
  for (const dir of readdirSync(migrationsDir).filter((d) => /^\d/.test(d)).sort()) {
    await pg.exec(readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8'));
  }
  return new PrismaClient({ adapter: new PrismaPGlite(pg) });
}
