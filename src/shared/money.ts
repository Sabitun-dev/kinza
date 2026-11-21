// Money is always whole so'm (integers).

/** 1250000 → "1 250 000" (regular spaces, safe for PDFs and Telegram). */
export function formatNumber(n: number): string {
  const sign = n < 0 ? '-' : '';
  const s = String(Math.round(Math.abs(n)));
  return sign + s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** 1250000 → "1 250 000 so'm" */
export function formatMoney(n: number): string {
  return `${formatNumber(n)} so'm`;
}

/** "1 250 000" / "1250000 so'm" → 1250000. Returns NaN when there are no digits. */
export function parseMoney(s: string): number {
  const digits = s.replace(/[^\d-]/g, '');
  return digits ? parseInt(digits, 10) : NaN;
}

/** Percent in basis points: 500 → 5% of amount, rounded to whole so'm. */
export function percentOf(amount: number, bp: number): number {
  return Math.round((amount * bp) / 10_000);
}
