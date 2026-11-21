import type { PrismaClient } from '../generated/prisma/client.ts';
import type { Role } from '../generated/prisma/enums.ts';
import type { BlobStore } from './files.ts';
import type { Notifier } from './notifier.ts';
import type { Settings } from './settings.ts';

export interface AuthUser {
  id: number;
  telegramId: number;
  name: string;
  role: Role;
  active: boolean;
}

/** Everything a business function needs. Built per request. */
export interface Ctx {
  db: PrismaClient;
  user: AuthUser;
  settings: Settings;
  blobs: BlobStore;
  notifier: Notifier;
  now: () => Date;
}

/** Long-lived dependencies, injected so tests can swap them. */
export interface Deps {
  db: PrismaClient;
  blobs: BlobStore;
  notifier: Notifier;
  botToken: string;
  ownerIds: number[];
  now: () => Date;
}

export function parseOwnerIds(env: string | undefined): number[] {
  return (env ?? '')
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
}
