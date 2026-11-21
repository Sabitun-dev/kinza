import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { tg } from './tg';
import { t } from '@shared/i18n';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Dev helper: outside Telegram you can paste initData into localStorage "devInitData". */
function initData(): string {
  if (tg) return tg.initData;
  try {
    return localStorage.getItem('devInitData') ?? '';
  } catch {
    return '';
  }
}

export async function request<T = any>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: {
        authorization: `tma ${initData()}`,
        ...(raw ? { 'content-type': raw.type } : body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(t('common.offline'), 0, 'offline');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  if (!res.ok) throw new ApiError(data?.error ?? t('common.error'), res.status, data?.code, data?.details);
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  patch: <T = any>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  upload: <T = any>(p: string, blob: Blob) => request<T>('POST', p, undefined, blob),
};

// ── Tiny query cache: show the last data instantly, refresh in the background. ──

type Entry = { data?: unknown; error?: ApiError; at: number; promise?: Promise<unknown> };
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Marks cached data stale. Screens using it reload. prefix "" = everything. */
export function invalidate(...prefixes: string[]) {
  for (const key of cache.keys()) {
    if (prefixes.some((p) => key.startsWith(p))) cache.get(key)!.at = 0;
  }
  emit();
}

function load(path: string) {
  const e = cache.get(path) ?? { at: 0 };
  if (e.promise) return e.promise;
  const p = api
    .get(path)
    .then((data) => {
      cache.set(path, { data, at: Date.now() });
    })
    .catch((error: ApiError) => {
      cache.set(path, { data: e.data, error, at: Date.now() });
    })
    .finally(emit);
  cache.set(path, { ...e, promise: p });
  return p;
}

export function useApi<T = any>(path: string | null, maxAgeMs = 20_000) {
  const v = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  const entry = path ? cache.get(path) : undefined;
  useEffect(() => {
    if (!path) return;
    const e = cache.get(path);
    if (!e || (!e.promise && Date.now() - e.at > maxAgeMs)) load(path);
  }, [path, v, maxAgeMs]);
  const reload = useCallback(() => {
    if (path) {
      const e = cache.get(path);
      if (e) e.at = 0;
      return load(path);
    }
  }, [path]);
  return {
    data: entry?.data as T | undefined,
    error: entry?.error,
    loading: !!path && entry?.data === undefined && !entry?.error,
    reload,
  };
}

/** Run a mutation with loading state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setBusy(true);
    try {
      return await fnRef.current(...args);
    } finally {
      setBusy(false);
    }
  }, []);
  return [run, busy] as const;
}
