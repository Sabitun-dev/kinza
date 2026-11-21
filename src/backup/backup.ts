import { gzipSync, gunzipSync } from 'node:zlib';
import type { Deps } from '../core/context.ts';
import type { PrismaClient } from '../generated/prisma/client.ts';
import { addDays, localDate, localTime } from '../shared/dates.ts';
import { getSettings } from '../core/settings.ts';

/**
 * Tables in the order they must be restored (parents before children).
 * Keys are Prisma model delegates; values are SQL table names.
 */
export const BACKUP_TABLES: [string, string][] = [
  ['user', 'users'],
  ['setting', 'settings'],
  ['file', 'files'],
  ['priceGroup', 'price_groups'],
  ['district', 'districts'],
  ['product', 'products'],
  ['productPrice', 'product_prices'],
  ['invite', 'invites'],
  ['shop', 'shops'],
  ['shopPrice', 'shop_prices'],
  ['supplierOrder', 'supplier_orders'],
  ['supplierOrderItem', 'supplier_order_items'],
  ['shipmentCost', 'shipment_costs'],
  ['supplierPayment', 'supplier_payments'],
  ['stockBatch', 'stock_batches'],
  ['order', 'orders'],
  ['orderItem', 'order_items'],
  ['orderItemBatch', 'order_item_batches'],
  ['cashHandover', 'cash_handovers'],
  ['payment', 'payments'],
  ['return', 'returns'],
  ['returnItem', 'return_items'],
  ['allocation', 'payment_allocations'],
  ['document', 'documents'],
  ['counter', 'counters'],
  ['expenseCategory', 'expense_categories'],
  ['expense', 'expenses'],
  ['stockMovement', 'stock_movements'],
  ['stockCount', 'stock_counts'],
  ['stockCountItem', 'stock_count_items'],
  ['visit', 'visits'],
  ['reminder', 'reminders'],
  ['notificationSent', 'notifications_sent'],
  ['auditLog', 'audit_log'],
  ['processedUpdate', 'processed_updates'],
  ['schedulerRun', 'scheduler_runs'],
  ['syncRequest', 'sync_requests'],
];

type Delegate = { findMany: (a?: unknown) => Promise<unknown[]>; createMany: (a: { data: unknown[] }) => Promise<unknown> };
const delegate = (db: PrismaClient, name: string) => (db as unknown as Record<string, Delegate>)[name];

export async function exportDatabase(db: PrismaClient): Promise<Uint8Array> {
  const tables: Record<string, unknown[]> = {};
  for (const [model] of BACKUP_TABLES) tables[model] = await delegate(db, model).findMany();
  const json = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), tables }, (_k, v) =>
    typeof v === 'bigint' ? { $bigint: v.toString() } : v,
  );
  return gzipSync(Buffer.from(json, 'utf8'));
}

/** Loads a backup into an EMPTY database (the restore script checks that first). */
export async function importDatabase(db: PrismaClient, gz: Uint8Array) {
  const data = JSON.parse(gunzipSync(gz).toString('utf8'), (_k, v) =>
    v && typeof v === 'object' && '$bigint' in v ? BigInt(v.$bigint) : v,
  ) as { tables: Record<string, Record<string, unknown>[]> };
  for (const [model, table] of BACKUP_TABLES) {
    const rows = data.tables[model] ?? [];
    for (let i = 0; i < rows.length; i += 500) {
      await delegate(db, model).createMany({ data: rows.slice(i, i + 500) });
    }
    if (rows.length && 'id' in rows[0] && typeof rows[0].id === 'number') {
      await db.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), (SELECT COALESCE(MAX(id), 1) FROM "${table}"))`,
      );
    }
  }
  return Object.fromEntries(BACKUP_TABLES.map(([m]) => [m, data.tables[m]?.length ?? 0]));
}

/** Daily backup to Netlify Blobs, keeping the last N days. Optionally sends the file to a chat. */
export async function runBackup(deps: Deps, opts: { sendTo?: number; reason: 'daily' | 'manual' }) {
  const settings = await getSettings(deps.db);
  const now = deps.now();
  const day = localDate(now);
  const data = await exportDatabase(deps.db);
  const suffix = opts.reason === 'manual' ? `-${localTime(now).replace(':', '')}` : '';
  const key = `backups/kinza-${day}${suffix}.json.gz`;
  await deps.blobs.put(key, data, 'application/gzip');

  // Remove backups older than the keep period
  const oldest = addDays(day, -settings.backupKeepDays);
  for (const k of await deps.blobs.list('backups/')) {
    const m = k.match(/kinza-(\d{4}-\d{2}-\d{2})/);
    if (m && m[1] < oldest) await deps.blobs.delete(k);
  }

  if (opts.sendTo) {
    await deps.notifier.sendDocument(
      opts.sendTo,
      { name: key.replace('backups/', ''), data },
      `💾 Zaxira nusxa: ${day} (${Math.round(data.byteLength / 1024)} KB)`,
    );
  }
  return { key, size: data.byteLength };
}
