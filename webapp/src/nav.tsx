import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tg, supports, haptic } from './tg';

// Screen-stack navigation without URLs. The Telegram BackButton pops the stack
// (or closes the open bottom sheet first).

export type TabName = 'today' | 'orders' | 'shops' | 'stock' | 'more';
export interface Route {
  name: string;
  params?: any;
  key: number;
}

interface NavApi {
  stack: Route[];
  tab: TabName;
  push(name: string, params?: any): void;
  replace(name: string, params?: any): void;
  pop(): void;
  setTab(tab: TabName): void;
  /** Go to a tab and open a screen on top of it (used by deep links). */
  open(tab: TabName, name?: string, params?: any): void;
}

const NavCtx = createContext<NavApi>(null as never);
export const useNav = () => useContext(NavCtx);

/** True for the screen currently on top. Lower screens stay mounted (keeps scroll and inputs). */
const ActiveCtx = createContext(true);
export const useIsActive = () => useContext(ActiveCtx);
export const ActiveProvider = ActiveCtx.Provider;

let keySeq = 1;

// Back handlers registered by sheets and dialogs; the last one wins.
const backHandlers: { fn: () => void }[] = [];
const backListeners = new Set<() => void>();
const notifyBack = () => backListeners.forEach((l) => l());

export function useBackHandler(fn: () => void, enabled: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const h = { fn: () => ref.current() };
    backHandlers.push(h);
    notifyBack();
    return () => {
      const i = backHandlers.indexOf(h);
      if (i >= 0) backHandlers.splice(i, 1);
      notifyBack();
    };
  }, [enabled]);
}

export function NavProvider({ children, initialTab = 'today' }: { children: ReactNode; initialTab?: TabName }) {
  const [tab, setTabState] = useState<TabName>(initialTab);
  const [stack, setStack] = useState<Route[]>([{ name: `tab:${initialTab}`, key: 0 }]);
  const [handlerCount, setHandlerCount] = useState(0);

  const push = useCallback((name: string, params?: any) => {
    haptic.tap();
    setStack((s) => [...s, { name, params, key: keySeq++ }]);
  }, []);
  const replace = useCallback((name: string, params?: any) => {
    setStack((s) => [...s.slice(0, -1), { name, params, key: keySeq++ }]);
  }, []);
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const setTab = useCallback((t: TabName) => {
    haptic.tap();
    setTabState(t);
    setStack([{ name: `tab:${t}`, key: keySeq++ }]);
    window.scrollTo(0, 0);
  }, []);
  const open = useCallback((t: TabName, name?: string, params?: any) => {
    setTabState(t);
    const root = { name: `tab:${t}`, key: keySeq++ };
    setStack(name ? [root, { name, params, key: keySeq++ }] : [root]);
  }, []);

  useEffect(() => {
    const l = () => setHandlerCount(backHandlers.length);
    backListeners.add(l);
    return () => void backListeners.delete(l);
  }, []);

  const goBack = useCallback(() => {
    const h = backHandlers[backHandlers.length - 1];
    if (h) h.fn();
    else pop();
  }, [pop]);

  const canGoBack = stack.length > 1 || handlerCount > 0;
  useEffect(() => {
    if (!supports.backButton || !tg) return;
    if (canGoBack) tg.BackButton.show();
    else tg.BackButton.hide();
  }, [canGoBack]);
  useEffect(() => {
    if (!supports.backButton || !tg) return;
    tg.BackButton.onClick(goBack);
    return () => tg!.BackButton.offClick(goBack);
  }, [goBack]);

  // Browser back (desktop testing / Android hardware back outside Telegram)
  useEffect(() => {
    if (supports.backButton) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && goBack();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack]);

  const api = useMemo(() => ({ stack, tab, push, replace, pop, setTab, open }), [stack, tab, push, replace, pop, setTab, open]);
  return <NavCtx.Provider value={api}>{children}</NavCtx.Provider>;
}

export function useGoBack() {
  const nav = useNav();
  return () => {
    const h = backHandlers[backHandlers.length - 1];
    if (h) h.fn();
    else nav.pop();
  };
}
