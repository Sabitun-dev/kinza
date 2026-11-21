import type { Deps } from './context.ts';
import { parseOwnerIds } from './context.ts';
import { getDb } from './db.ts';
import { netlifyBlobStore } from './files.ts';
import { telegramNotifier } from './notifier.ts';

let cached: Promise<Deps> | undefined;

/** Production dependencies, built from environment variables once per function instance. */
export function getDeps(): Promise<Deps> {
  cached ??= (async () => {
    const botToken = requireEnv('BOT_TOKEN');
    const db = getDb();
    const appRow = await db.setting.findUnique({ where: { key: 'appUrl' } });
    const appBase = (appRow?.value as string) || process.env.URL || '';
    return {
      db,
      blobs: await netlifyBlobStore(),
      notifier: telegramNotifier(botToken, appBase),
      botToken,
      ownerIds: parseOwnerIds(process.env.OWNER_TELEGRAM_IDS),
      now: () => new Date(),
    };
  })();
  cached.catch(() => (cached = undefined));
  return cached;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Environment variable ${name} is not set`);
  return v;
}
