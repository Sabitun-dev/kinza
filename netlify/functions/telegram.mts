import type { Config } from '@netlify/functions';
import type { Bot } from 'grammy';
import { getDeps } from '../../src/core/deps.ts';
import { createBot } from '../../src/bot/bot.ts';

let bot: Bot | undefined;

/** Telegram webhook. Rejects calls without our secret token and ignores repeated updates. */
export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('Unauthorized', { status: 401 });
  }
  const update = await req.json();
  const deps = await getDeps();
  try {
    await deps.db.processedUpdate.create({ data: { updateId: BigInt(update.update_id) } });
  } catch {
    return new Response('duplicate'); // already handled
  }
  try {
    bot ??= await createBot(deps);
    await bot.handleUpdate(update);
  } catch (err) {
    console.error('Update failed', update.update_id, err);
  }
  return new Response('ok');
};

export const config: Config = { path: '/telegram' };
