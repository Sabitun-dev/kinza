import { daysBetween, formatDate, formatDateHuman, localDate, addDays } from '@shared/dates';
import { haptic, openLink } from './tg';

export { formatDate, formatDateHuman, localDate, addDays };

/** "bugun", "kecha", "3 kun oldin", "21 noyabr" */
export function ago(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = localDate(new Date(iso));
  const n = daysBetween(d, localDate());
  if (n === 0) return 'bugun';
  if (n === 1) return 'kecha';
  if (n < 30) return `${n} kun oldin`;
  return formatDateHuman(d);
}

export function daysAgo(date: string | null | undefined): number | null {
  if (!date) return null;
  return daysBetween(date.slice(0, 10), localDate());
}

/** "Bugun", "Ertaga", "Dushanba, 23 noyabr" */
export function dayLabel(date: string): string {
  const today = localDate();
  if (date === today) return 'Bugun';
  if (date === addDays(today, 1)) return 'Ertaga';
  if (date === addDays(today, -1)) return 'Kecha';
  return formatDateHuman(date);
}

export function callPhone(phone: string) {
  haptic.impact();
  openLink(`tel:${phone.replace(/[^\d+]/g, '')}`);
}

export function openMaps(lat: number, lng: number, provider: 'yandex' | 'google' = 'yandex') {
  const url =
    provider === 'yandex'
      ? `https://yandex.uz/maps/?pt=${lng},${lat}&z=17&l=map`
      : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  openLink(url);
}

export function navigateTo(lat: number, lng: number, provider: 'yandex' | 'google' = 'yandex') {
  const url =
    provider === 'yandex'
      ? `https://yandex.uz/maps/?rtext=~${lat},${lng}&rtt=auto`
      : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  openLink(url);
}

/** Current GPS position (null if refused / unavailable within the timeout). */
export function getPosition(timeoutMs = 8000): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

let lastPos: { lat: number; lng: number } | null = null;
/** Cached position for sorting lists (refreshed in the background). */
export async function roughPosition() {
  if (lastPos) {
    getPosition(5000).then((p) => p && (lastPos = p));
    return lastPos;
  }
  const p = await getPosition(4000);
  if (p) lastPos = p;
  return lastPos;
}

export function uid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/**
 * Location for driving mode: Telegram's LocationManager when available (Bot API 8.0+),
 * otherwise the browser's geolocation. Only called while driving mode is open.
 */
export function readLocation(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  const lm = (window.Telegram?.WebApp as any)?.LocationManager;
  if (lm && typeof lm.getLocation === 'function') {
    return new Promise((resolve) => {
      const get = () =>
        lm.getLocation((d: any) => (d ? resolve({ lat: d.latitude, lng: d.longitude, accuracy: d.horizontal_accuracy ?? 50 }) : getPosition(8000).then(resolve)));
      try {
        if (!lm.isInited) lm.init(() => (lm.isLocationAvailable ? get() : getPosition(8000).then(resolve)));
        else if (lm.isLocationAvailable) get();
        else getPosition(8000).then(resolve);
      } catch {
        getPosition(8000).then(resolve);
      }
    });
  }
  return getPosition(8000);
}

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type NavApp = 'yandexnavi' | 'yandex' | 'google';

function store(key: string, value?: string) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
  return null;
}

export const navChoice = {
  get: () => (store('navApp') as NavApp | null) ?? null,
  set: (v: NavApp) => store('navApp', v),
};

/**
 * Opens turn-by-turn navigation to a shop. Yandex Navigator is tried through its app link; if the
 * app does not open within ~1.5 s, the Yandex Maps web route is opened instead.
 */
export function openNavigation(lat: number, lng: number, app: NavApp) {
  haptic.impact();
  if (app === 'google') return openLink(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`);
  const web = `https://yandex.uz/maps/?rtext=~${lat},${lng}&rtt=auto`;
  if (app === 'yandex') return openLink(web);
  let left = false;
  const onHide = () => (left = true);
  document.addEventListener('visibilitychange', onHide, { once: true });
  window.location.href = `yandexnavi://build_route_on_map?lat_to=${lat}&lon_to=${lng}`;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (!left && !document.hidden) openLink(web);
  }, 1500);
}
