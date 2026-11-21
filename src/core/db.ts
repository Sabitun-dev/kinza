import { PrismaClient, Prisma } from '../generated/prisma/client.ts';
import { PrismaNeon } from '@prisma/adapter-neon';
import { neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
export type DbOrTx = PrismaClient | Prisma.TransactionClient;
export { Prisma };

let client: PrismaClient | undefined;

/** One Prisma client per function instance (reused across warm invocations). */
export function getDb(): PrismaClient {
  if (!client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    neonConfig.webSocketConstructor = ws;
    client = new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });
  }
  return client;
}

/** Runs fn in a transaction, or directly inside an existing one. */
export async function inTx<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if ('$transaction' in db) return (db as PrismaClient).$transaction(fn, { timeout: 20_000, maxWait: 10_000 });
  return fn(db as Tx);
}
