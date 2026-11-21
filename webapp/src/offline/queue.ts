import { openDB, type IDBPDatabase } from 'idb';
import { api, ApiError, invalidate } from '../api';
import { toast } from '../ui/toast';

// Orders and visits made without internet wait here (IndexedDB on the phone) and are sent
// automatically when the connection is back. Each item carries an idempotency key, so the
// server never creates it twice even if it is sent again. The server assigns numbers,
// PDFs, stock and payments during sync — never the phone.

export interface QueueItem {
  key: string; // idempotency key
  kind: 'order' | 'visit';
  title: string;
  payload: any;
  createdAt: number;
  tries: number;
  error?: string; // last business error (e.g. not enough stock) — needs attention
}

let dbp: Promise<IDBPDatabase> | null = null;
const db = () =>
  (dbp ??= openDB('kinza-offline', 1, {
    upgrade(d) {
      d.createObjectStore('queue', { keyPath: 'key' });
    },
  }));

const subs = new Set<(n: number) => void>();
let count = 0;
async function refreshCount() {
  try {
    count = await (await db()).count('queue');
  } catch {
    count = 0;
  }
  subs.forEach((s) => s(count));
}
export function onQueueCount(cb: (n: number) => void) {
  subs.add(cb);
  cb(count);
  refreshCount();
  return () => void subs.delete(cb);
}

export async function listQueue(): Promise<QueueItem[]> {
  return (await db()).getAll('queue');
}

async function put(item: QueueItem) {
  await (await db()).put('queue', item);
  await refreshCount();
}

export async function removeQueued(key: string) {
  await (await db()).delete('queue', key);
  await refreshCount();
}

export function queueOrder(payload: { shopId: number; shopName: string; idempotencyKey: string } & Record<string, unknown>) {
  const { shopName, ...rest } = payload;
  return put({ key: payload.idempotencyKey, kind: 'order', title: `Buyurtma: ${shopName}`, payload: { ...rest, offline: true }, createdAt: Date.now(), tries: 0 });
}

export function queueVisit(payload: { idempotencyKey: string; shopName: string } & Record<string, unknown>) {
  const { shopName, ...rest } = payload;
  return put({ key: payload.idempotencyKey, kind: 'visit', title: `Tashrif: ${shopName}`, payload: rest, createdAt: Date.now(), tries: 0 });
}

let flushing = false;

/** Sends everything waiting. Stops at the first network error (still offline). */
export async function flushQueue(): Promise<number> {
  if (flushing || !navigator.onLine) return 0;
  flushing = true;
  let sent = 0;
  try {
    const items = (await listQueue()).sort((a, b) => a.createdAt - b.createdAt);
    for (const item of items) {
      try {
        const path = item.kind === 'order' ? '/orders' : '/visits';
        const r = await api.post(path, item.payload);
        await removeQueued(item.key);
        sent++;
        if (item.kind === 'order' && r?.confirmError) {
          toast(`${item.title}: ${r.confirmError.message}. Qoralama sifatida saqlandi.`, { tone: 'error' });
        }
      } catch (e) {
        const err = e as ApiError;
        if (err.code === 'offline' || err.status >= 500 || err.status === 0) break;
        // Business error (e.g. shop archived): keep it, show why, let the user decide
        await put({ ...item, tries: item.tries + 1, error: err.message });
      }
    }
  } finally {
    flushing = false;
  }
  if (sent) {
    invalidate('/orders', '/shops', '/products', '/today', '/visits');
    toast(`Yuborildi ✅ (${sent})`);
  }
  return sent;
}

let started = false;
export function startSync() {
  if (started) return;
  started = true;
  window.addEventListener('online', () => flushQueue());
  setInterval(() => {
    if (count > 0) flushQueue();
  }, 30_000);
  refreshCount().then(() => flushQueue());
}
