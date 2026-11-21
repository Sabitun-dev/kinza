import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '../../src/generated/prisma/client.ts';

const migrationsDir = join(import.meta.dirname, '../../prisma/migrations');
const migrations = readdirSync(migrationsDir)
  .filter((d) => /^\d/.test(d))
  .sort()
  .map((d) => readFileSync(join(migrationsDir, d, 'migration.sql'), 'utf8'));

/** Open test databases; closed after every test (tests/helpers/setup.ts) to keep memory low. */
export const openDatabases: { pg: PGlite; prisma: PrismaClient }[] = [];

/** A fresh in-memory Postgres with all migrations applied. */
export async function createTestDb(): Promise<PrismaClient> {
  const pg = new PGlite();
  for (const sql of migrations) await pg.exec(sql);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pg) });
  openDatabases.push({ pg, prisma });
  return prisma;
}

export async function closeTestDbs() {
  for (const d of openDatabases.splice(0)) {
    await d.prisma.$disconnect().catch(() => {});
    await d.pg.close().catch(() => {});
  }
}
