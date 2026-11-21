import { uz, type Messages } from './uz.ts';

// To add Russian later: create ru.ts with the same shape as uz.ts and add it here.
const LANGS: Record<string, Messages> = { uz };
let current: Messages = uz;

export function setLang(lang: string) {
  current = LANGS[lang] ?? uz;
}

type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends readonly unknown[]
      ? never
      : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MsgKey = Leaves<Messages>;

/** t('order.total', { sum: '1 000' }) → text with {sum} replaced. Unknown keys return the key. */
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  let node: unknown = current;
  for (const part of key.split('.')) node = (node as Record<string, unknown>)?.[part];
  let s = typeof node === 'string' ? node : key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
