import type { Config } from '@netlify/functions';
import { runSetup } from '../../src/setup/setup.ts';

/** /setup?key=SETUP_SECRET — connects the bot and checks everything. Safe to open again. */
export default async (req: Request) => {
  const url = new URL(req.url);
  const secret = process.env.SETUP_SECRET;
  if (!secret || url.searchParams.get('key') !== secret) {
    return new Response('Not found', { status: 404 });
  }
  const html = await runSetup(url.origin);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
};

export const config: Config = { path: '/setup' };
