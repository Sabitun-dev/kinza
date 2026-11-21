import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface ValidInitData {
  user: TelegramUser;
  authDate: number;
  startParam?: string;
}

export class InitDataError extends Error {}

/**
 * Checks the Mini App initData signature (HMAC-SHA256 with the bot token) and its age.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 24 * 3600,
  nowSeconds = Math.floor(Date.now() / 1000),
): ValidInitData {
  if (!initData) throw new InitDataError('empty');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new InitDataError('no hash');
  params.delete('hash');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new InitDataError('bad hash');

  const authDate = Number(params.get('auth_date'));
  if (!authDate || nowSeconds - authDate > maxAgeSeconds) throw new InitDataError('expired');

  const userRaw = params.get('user');
  if (!userRaw) throw new InitDataError('no user');
  const user = JSON.parse(userRaw) as TelegramUser;
  if (!user?.id) throw new InitDataError('no user id');
  return { user, authDate, startParam: params.get('start_param') ?? undefined };
}

/** Builds a signed initData string. Used by tests and the local demo mode only. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  const p = new URLSearchParams(fields);
  p.set('hash', hash);
  return p.toString();
}
