// Thin wrapper over the official telegram-web-app.js (window.Telegram.WebApp).
// Everything degrades gracefully in a normal browser (for local development).

interface TgButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  setText(t: string): TgButton;
  show(): TgButton;
  hide(): TgButton;
  enable(): TgButton;
  disable(): TgButton;
  showProgress(leaveActive?: boolean): TgButton;
  hideProgress(): TgButton;
  onClick(cb: () => void): TgButton;
  offClick(cb: () => void): TgButton;
  setParams(p: { text?: string; color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean }): TgButton;
}

interface TgWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number; first_name: string } };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  isExpanded: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  setBottomBarColor?(c: string): void;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  disableVerticalSwipes?(): void;
  isVersionAtLeast(v: string): boolean;
  onEvent(e: string, cb: (...a: unknown[]) => void): void;
  offEvent(e: string, cb: (...a: unknown[]) => void): void;
  openLink(url: string, opts?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  showConfirm(msg: string, cb: (ok: boolean) => void): void;
  showAlert(msg: string, cb?: () => void): void;
  showScanQrPopup(p: { text?: string }, cb: (text: string) => boolean | void): void;
  closeScanQrPopup(): void;
  requestContact?(cb: (ok: boolean) => void): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  MainButton: TgButton;
  HapticFeedback: {
    impactOccurred(s: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(t: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  CloudStorage: {
    setItem(k: string, v: string, cb?: (e: unknown, ok?: boolean) => void): void;
    getItem(k: string, cb: (e: unknown, v?: string) => void): void;
  };
  LocationManager?: unknown;
}

declare global {
  interface Window {
    Telegram?: { WebApp: TgWebApp };
  }
}

export const tg: TgWebApp | undefined = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : undefined;
export const inTelegram = !!tg;
const at = (v: string) => !!tg && tg.isVersionAtLeast(v);

export function initTelegram() {
  if (!tg) {
    applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    return;
  }
  tg.ready();
  tg.expand();
  if (at('7.7')) tg.disableVerticalSwipes?.();
  applyTheme(tg.colorScheme);
  tg.onEvent('themeChanged', () => applyTheme(tg.colorScheme));
}

function applyTheme(scheme: 'light' | 'dark') {
  document.documentElement.dataset.theme = scheme;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (tg && at('6.1')) {
    tg.setHeaderColor(bg);
    tg.setBackgroundColor(bg);
    if (at('7.10')) tg.setBottomBarColor?.(bg);
  }
}

/** The start parameter from a t.me/bot/app?startapp=… link or our web_app button URL. */
export function startParam(): string | null {
  const fromTg = tg?.initDataUnsafe?.start_param;
  if (fromTg) return fromTg;
  return new URLSearchParams(location.search).get('startapp');
}

export const haptic = {
  tap: () => tg?.HapticFeedback.selectionChanged(),
  impact: () => tg?.HapticFeedback.impactOccurred('light'),
  success: () => tg?.HapticFeedback.notificationOccurred('success'),
  error: () => tg?.HapticFeedback.notificationOccurred('error'),
  warning: () => tg?.HapticFeedback.notificationOccurred('warning'),
};

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (tg && at('6.2')) tg.showConfirm(message, resolve);
    else resolve(window.confirm(message));
  });
}

export function alertDialog(message: string): Promise<void> {
  return new Promise((resolve) => {
    if (tg && at('6.2')) tg.showAlert(message, resolve);
    else {
      window.alert(message);
      resolve();
    }
  });
}

/** Opens tel:, maps and other external links. */
export function openLink(url: string) {
  if (url.startsWith('https://t.me/')) {
    if (tg) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  } else if (tg && !url.startsWith('tel:')) tg.openLink(url);
  else window.location.href = url;
}

export function scanQr(text: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!tg || !at('6.4')) return resolve(null);
    tg.showScanQrPopup({ text }, (value) => {
      resolve(value);
      return true;
    });
  });
}

/** Small key/value store synced through Telegram (falls back to localStorage). */
export const cloud = {
  get(key: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (tg && at('6.9')) tg.CloudStorage.getItem(key, (_e, v) => resolve(v ?? null));
      else {
        try {
          resolve(localStorage.getItem(key));
        } catch {
          resolve(null);
        }
      }
    });
  },
  set(key: string, value: string) {
    if (tg && at('6.9')) tg.CloudStorage.setItem(key, value);
    else {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* private mode */
      }
    }
  },
};

export const supports = {
  mainButton: inTelegram,
  backButton: inTelegram && at('6.1'),
  qr: inTelegram && at('6.4'),
};
