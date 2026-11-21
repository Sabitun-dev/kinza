import { useSyncExternalStore } from 'react';
import { haptic } from '../tg';
import { t } from '@shared/i18n';
import { cx } from './kit';

interface ToastItem {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info';
  undo?: () => void;
}

let items: ToastItem[] = [];
let seq = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

function remove(id: number) {
  items = items.filter((i) => i.id !== id);
  emit();
}

/** toast("Saqlandi ✅") · toast.error(msg) · toast("O'chirildi", { undo }) */
export function toast(text: string, opts: { undo?: () => void; tone?: ToastItem['tone'] } = {}) {
  const item = { id: seq++, text, tone: opts.tone ?? 'ok', undo: opts.undo };
  if (item.tone === 'ok') haptic.success();
  if (item.tone === 'error') haptic.error();
  items = [...items.slice(-2), item];
  emit();
  setTimeout(() => remove(item.id), opts.undo ? 5000 : item.tone === 'error' ? 4500 : 2500);
}
toast.error = (e: unknown) => toast(e instanceof Error ? e.message : String(e), { tone: 'error' });
toast.info = (text: string) => toast(text, { tone: 'info' });

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      subs.add(l);
      return () => subs.delete(l);
    },
    () => items,
  );
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 px-4 pb-[calc(env(safe-area-inset-bottom)+88px)]">
      {list.map((i) => (
        <div
          key={i.id}
          className={cx(
            'animate-toast pointer-events-auto flex w-full max-w-[440px] items-center gap-3 rounded-[14px] px-4 py-3 text-[15.5px] font-medium shadow-lg',
            i.tone === 'error' ? 'bg-danger text-white' : 'bg-[#10261b] text-white',
          )}
        >
          <span className="flex-1">{i.text}</span>
          {i.undo && (
            <button
              className="font-bold text-accent"
              onClick={() => {
                i.undo!();
                remove(i.id);
              }}
            >
              {t('common.undo')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
