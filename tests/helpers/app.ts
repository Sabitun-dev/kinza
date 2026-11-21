import { createApp } from '../../src/api/app.ts';
import { signInitData } from '../../src/auth/initData.ts';
import type { Deps } from '../../src/core/context.ts';
import { memoryBlobStore } from '../../src/core/files.ts';
import { recordingNotifier } from '../../src/core/notifier.ts';
import { ensureBaseData } from '../../src/setup/baseData.ts';
import { createTestDb } from './db.ts';

export const BOT_TOKEN = '999:TEST';
export const OWNER_TG = 1001;

export async function createTestApp(opts: { now?: () => Date } = {}) {
  process.env.BOT_TOKEN = BOT_TOKEN;
  const db = await createTestDb();
  await ensureBaseData(db);
  const notifier = recordingNotifier();
  const blobs = memoryBlobStore();
  const deps: Deps = {
    db,
    blobs,
    notifier,
    botToken: BOT_TOKEN,
    ownerIds: [OWNER_TG],
    now: opts.now ?? (() => new Date()),
  };
  const app = createApp(deps);

  const initData = (tgId: number, startParam?: string) =>
    signInitData(
      {
        auth_date: String(Math.floor(Date.now() / 1000)),
        user: JSON.stringify({ id: tgId, first_name: `User${tgId}` }),
        ...(startParam ? { start_param: startParam } : {}),
      },
      BOT_TOKEN,
    );

  /** Calls the API as a Telegram user. Returns { status, data }. */
  async function call<T = any>(tgId: number, method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: { authorization: `tma ${initData(tgId)}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: T;
    try {
      data = JSON.parse(text);
    } catch {
      data = text as T;
    }
    return { status: res.status, data };
  }

  const as = (tgId: number) => ({
    get: <T = any>(p: string) => call<T>(tgId, 'GET', p),
    post: <T = any>(p: string, b?: unknown) => call<T>(tgId, 'POST', p, b ?? {}),
    put: <T = any>(p: string, b?: unknown) => call<T>(tgId, 'PUT', p, b ?? {}),
    patch: <T = any>(p: string, b?: unknown) => call<T>(tgId, 'PATCH', p, b ?? {}),
  });

  const owner = as(OWNER_TG);
  await owner.get('/api/me'); // creates the owner row

  /** Invites and registers a new person with a role. */
  async function addUser(tgId: number, role: 'AGENT' | 'DRIVER') {
    const inv = await owner.post('/api/invites', { role });
    const token = inv.data.token as string;
    const r = await as(tgId).post('/api/invites/accept', { token });
    if (r.status !== 200) throw new Error('invite failed ' + JSON.stringify(r.data));
    return { ...as(tgId), id: r.data.user.id as number, tgId };
  }

  return { app, db, deps, notifier, blobs, as, owner, addUser, call };
}
