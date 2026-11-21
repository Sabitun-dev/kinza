import { useEffect, useRef, useSyncExternalStore } from 'react';
import { tg, supports } from './tg';
import { useIsActive } from './nav';

// The Telegram MainButton: one main action per screen, in the thumb zone.
// Outside Telegram a look-alike button is drawn at the bottom of the page.

interface MainButtonState {
  text: string;
  disabled?: boolean;
  progress?: boolean;
  visible?: boolean;
  color?: 'brand' | 'accent' | 'danger';
}

let current: (MainButtonState & { onClick: () => void }) | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

const COLORS = { brand: '#0F5D3A', accent: '#E8A317', danger: '#C62F2F' };
const INK = { brand: '#FFFFFF', accent: '#2A1D00', danger: '#FFFFFF' };

let tgHandler: (() => void) | null = null;

function apply() {
  if (!supports.mainButton || !tg) return emit();
  const mb = tg.MainButton;
  if (tgHandler) mb.offClick(tgHandler);
  tgHandler = null;
  if (!current || current.visible === false) {
    mb.hide();
    return;
  }
  const c = current.color ?? 'brand';
  const dark = document.documentElement.dataset.theme === 'dark';
  mb.setParams({
    text: current.text,
    color: c === 'brand' && dark ? '#2F9E68' : COLORS[c],
    text_color: INK[c],
    is_active: !current.disabled,
    is_visible: true,
  });
  if (current.progress) mb.showProgress(false);
  else mb.hideProgress();
  const handler = current.onClick;
  tgHandler = () => {
    if (current && !current.disabled && !current.progress) handler();
  };
  mb.onClick(tgHandler);
}

export function useMainButton(state: MainButtonState & { onClick: () => void }) {
  const active = useIsActive();
  const ref = useRef(state.onClick);
  ref.current = state.onClick;
  const { text, disabled, progress, visible, color } = state;
  useEffect(() => {
    if (!active) return;
    const mine = { text, disabled, progress, visible, color, onClick: () => ref.current() };
    current = mine;
    apply();
    return () => {
      if (current === mine) {
        current = null;
        apply();
      }
    };
  }, [active, text, disabled, progress, visible, color]);
}

/** Browser fallback (rendered once by App). */
export function MainButtonFallback() {
  const s = useSyncExternalStore(
    (l) => {
      subs.add(l);
      return () => subs.delete(l);
    },
    () => current,
  );
  if (supports.mainButton || !s || s.visible === false) return null;
  const c = s.color ?? 'brand';
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 bg-bg/95 px-4 pt-2 safe-bottom">
      <button
        disabled={s.disabled || s.progress}
        onClick={() => s.onClick()}
        className={`h-[52px] w-full rounded-[14px] text-[17px] font-semibold disabled:opacity-50 ${
          c === 'accent' ? 'bg-accent text-accent-ink' : c === 'danger' ? 'bg-danger text-white' : 'bg-brand text-brand-ink'
        }`}
      >
        {s.progress ? '…' : s.text}
      </button>
    </div>
  );
}

export const hasFallbackMainButton = () => !supports.mainButton && !!current && current.visible !== false;
