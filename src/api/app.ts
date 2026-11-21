import { Hono, type Context } from 'hono';
import { validateInitData, InitDataError, type ValidInitData } from '../auth/initData.ts';
import { resolveUser } from '../auth/users.ts';
import type { Ctx, Deps } from '../core/context.ts';
import { AppError } from '../core/errors.ts';
import { sanitizeFor } from '../core/permissions.ts';
import { getSettings } from '../core/settings.ts';
import { registerRoutes } from './routes/index.ts';

export type Env = { Variables: { ctx: Ctx; tg: ValidInitData } };
export type App = Hono<Env>;

/** Routes that someone without an account may call (to accept an invite or see "no access"). */
const OPEN_ROUTES = new Set(['/api/me', '/api/invites/accept']);

export function createApp(deps: Deps): App {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.message, code: err.code, details: err.details }, err.status as 400);
    if (err instanceof InitDataError) return c.json({ error: 'Telegram orqali qayta oching', code: 'auth' }, 401);
    console.error('API error', c.req.method, c.req.path, err);
    return c.json({ error: "Xatolik yuz berdi. Qayta urinib ko'ring.", code: 'server' }, 500);
  });

  // Files are opened by signed links (no header), so they skip initData auth.
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/files/') && c.req.method === 'GET') return next();
    const header = c.req.header('authorization') ?? '';
    const initData = header.startsWith('tma ') ? header.slice(4) : '';
    const tg = validateInitData(initData, deps.botToken);
    const user = await resolveUser(deps.db, tg.user, deps.ownerIds);
    const settings = await getSettings(deps.db);
    c.set('tg', tg);
    if (!user || !user.active) {
      if (OPEN_ROUTES.has(c.req.path)) {
        c.set('ctx', { ...deps, user: null as never, settings });
        return next();
      }
      return c.json({ error: "Ruxsat yo'q. Egasidan taklif havolasini so'rang.", code: 'no_access' }, 403);
    }
    c.set('ctx', { db: deps.db, user, settings, blobs: deps.blobs, notifier: deps.notifier, now: deps.now });
    return next();
  });

  registerRoutes(app, deps);
  return app;
}

/** JSON response, with fields this user's role may not see removed. */
export function ok(c: Context<Env>, data: unknown, status = 200) {
  const ctx = c.get('ctx');
  const clean = ctx?.user ? sanitizeFor(ctx.user.role, data) : data;
  return c.newResponse(JSON.stringify(clean, jsonReplacer), status as 200, { 'content-type': 'application/json' });
}

function jsonReplacer(_k: string, v: unknown) {
  return typeof v === 'bigint' ? Number(v) : v;
}

export async function body<T = Record<string, unknown>>(c: Context<Env>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new AppError("So'rov noto'g'ri");
  }
}

export const idParam = (c: Context<Env>, name = 'id') => {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw new AppError("Noto'g'ri raqam");
  return n;
};
