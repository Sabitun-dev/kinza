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

// Transaction clients opened by inTx. (A Prisma transaction client also has a $transaction
// method, so we cannot tell them apart by shape.)
const openTx = new WeakSet<object>();

/** Runs fn in a transaction, or directly inside an existing one. */
export async function inTx<T>(db: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (openTx.has(db) || !('$transaction' in db)) return fn(db as Tx);
  return (db as PrismaClient).$transaction(
    (tx) => {
      openTx.add(tx);
      return fn(tx);
    },
    { timeout: 20_000, maxWait: 10_000 },
  );
}
