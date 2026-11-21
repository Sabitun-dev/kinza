import { createHmac, randomBytes } from 'node:crypto';
import type { DbOrTx } from './db.ts';
import type { FileKind } from '../generated/prisma/enums.ts';

/** Where file bytes live. Netlify Blobs in production, memory in tests. */
export interface BlobStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export async function netlifyBlobStore(): Promise<BlobStore> {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: 'kinza-files', consistency: 'strong' });
  return {
    async put(key, data, contentType) {
      await store.set(key, new Blob([data as BlobPart]), { metadata: { contentType } });
    },
    async get(key) {
      const buf = await store.get(key, { type: 'arrayBuffer' });
      return buf ? new Uint8Array(buf) : null;
    },
    async delete(key) {
      await store.delete(key);
    },
    async list(prefix) {
      const { blobs } = await store.list({ prefix });
      return blobs.map((b) => b.key);
    },
  };
}

export function memoryBlobStore(): BlobStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    async put(key, bytes) {
      data.set(key, bytes);
    },
    async get(key) {
      return data.get(key) ?? null;
    },
    async delete(key) {
      data.delete(key);
    },
    async list(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export async function saveFile(
  db: DbOrTx,
  blobs: BlobStore,
  input: { kind: FileKind; name: string; contentType: string; data: Uint8Array; userId?: number | null },
) {
  if (input.data.byteLength > MAX_UPLOAD_BYTES) throw new Error('Fayl juda katta');
  const isPhoto = input.kind.endsWith('PHOTO') || input.kind === 'LOGO';
  if (isPhoto && !IMAGE_TYPES.includes(input.contentType)) throw new Error('Faqat rasm (JPG, PNG, WEBP)');
  const key = `${input.kind.toLowerCase()}/${new Date().toISOString().slice(0, 7)}/${randomBytes(12).toString('hex')}`;
  await blobs.put(key, input.data, input.contentType);
  return db.file.create({
    data: {
      key,
      kind: input.kind,
      name: input.name.slice(0, 200),
      contentType: input.contentType,
      size: input.data.byteLength,
      createdById: input.userId ?? null,
    },
  });
}

// Signed links let <img> tags and Telegram share links open private files without a login header.
// The server only hands out a signed link to a user who is allowed to see that file.

function signingKey(): string {
  const secret = process.env.BOT_TOKEN || 'dev-secret';
  return createHmac('sha256', 'kinza-files').update(secret).digest('hex');
}

export function signFile(fileId: number, ttlSeconds = 2 * 86_400, now = Date.now()): string {
  // Round the expiry to a day so the same URL is reused (browser cache friendly).
  const exp = Math.ceil((now / 1000 + ttlSeconds) / 86_400) * 86_400;
  const sig = createHmac('sha256', signingKey()).update(`${fileId}.${exp}`).digest('hex').slice(0, 32);
  return `/api/files/${fileId}?exp=${exp}&sig=${sig}`;
}

export function verifyFileSignature(fileId: number, exp: number, sig: string, now = Date.now()): boolean {
  if (!exp || exp * 1000 < now) return false;
  const expected = createHmac('sha256', signingKey()).update(`${fileId}.${exp}`).digest('hex').slice(0, 32);
  return expected === sig;
}

export function fileUrl(fileId: number | null | undefined, ttlSeconds?: number): string | null {
  return fileId ? signFile(fileId, ttlSeconds) : null;
}
