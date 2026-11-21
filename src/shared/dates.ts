// All times are stored in UTC. Business dates are Asia/Tashkent (UTC+5, no daylight saving).
// A "local date" is a 'YYYY-MM-DD' string.

export const TZ_OFFSET_MIN = 5 * 60;

const pad = (n: number) => String(n).padStart(2, '0');

/** Tashkent wall-clock parts of an instant. */
export function localParts(d: Date = new Date()) {
  const t = new Date(d.getTime() + TZ_OFFSET_MIN * 60_000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: t.getUTCDay() === 0 ? 7 : t.getUTCDay(), // 1 = Monday … 7 = Sunday
  };
}

export function localDate(d: Date = new Date()): string {
  const p = localParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:MM" in Tashkent. */
export function localTime(d: Date = new Date()): string {
  const p = localParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function addDays(date: string, n: number): string {
  const t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 1 = Monday … 7 = Sunday */
export function weekday(date: string): number {
  const d = new Date(date + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
}

/** UTC instant when a Tashkent local date starts. */
export function startOfLocalDay(date: string): Date {
  return new Date(Date.parse(date + 'T00:00:00Z') - TZ_OFFSET_MIN * 60_000);
}

/** UTC instant for a Tashkent local date + "HH:MM". */
export function localDateTime(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(startOfLocalDay(date).getTime() + (h * 60 + m) * 60_000);
}

/** Working days ahead (Sundays not counted when skipSundays). */
export function addWorkingDays(date: string, n: number, skipSundays: boolean): string {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (skipSundays && weekday(d) === 7) continue;
    left--;
  }
  if (skipSundays && weekday(d) === 7) d = addDays(d, 1);
  return d;
}

/** Prisma @db.Date <-> local date string */
export function toDbDate(date: string): Date {
  return new Date(date + 'T00:00:00Z');
}
export function fromDbDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export const WEEKDAYS_UZ = ['', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba', 'Yakshanba'];
export const MONTHS_UZ = ['', 'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

/** "2026-11-21" → "21.11.2026" */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '';
  const [y, m, d] = date.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

/** "2026-11-21" → "21 noyabr" */
export function formatDateHuman(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS_UZ[m]}`;
}

/** ISO-8601 week number (weeks start on Monday; week 1 contains 4 January). */
export function isoWeek(date: string): number {
  const d = new Date(date + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

export const weekParityOf = (date: string): 'ODD' | 'EVEN' => (isoWeek(date) % 2 === 1 ? 'ODD' : 'EVEN');

/** The next date (strictly after `date`) on the given weekday (1 = Monday … 7 = Sunday). */
export function nextWeekday(date: string, wd: number): string {
  let d = addDays(date, 1);
  while (weekday(d) !== wd) d = addDays(d, 1);
  return d;
}
