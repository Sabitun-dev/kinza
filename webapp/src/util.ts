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
