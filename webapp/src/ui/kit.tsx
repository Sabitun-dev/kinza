import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { haptic } from '../tg';
import { t } from '@shared/i18n';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ── Button ──
type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger' | 'soft';
export function Button({
  variant = 'primary',
  size = 'lg',
  icon,
  loading,
  block,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'lg' | 'md' | 'sm'; icon?: IconName; loading?: boolean; block?: boolean }) {
  const v = {
    primary: 'bg-brand text-brand-ink',
    accent: 'bg-accent text-accent-ink',
    secondary: 'bg-card text-text border border-line',
    soft: 'bg-brand-soft text-brand',
    ghost: 'bg-transparent text-brand',
    danger: 'bg-danger-soft text-danger',
  }[variant];
  const s = { lg: 'h-[52px] px-5 text-[17px] rounded-[14px]', md: 'h-12 px-4 text-[16px] rounded-[12px]', sm: 'h-10 px-3 text-[15px] rounded-[10px]' }[size];
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      onClick={(e) => {
        haptic.tap();
        rest.onClick?.(e);
      }}
      className={cx(
        'inline-flex items-center justify-center gap-2 font-semibold transition active:scale-[0.98] disabled:opacity-50 select-none',
        v,
        s,
        block && 'w-full',
        className,
      )}
    >
      {loading ? <Spinner /> : icon && <Icon name={icon} size={size === 'sm' ? 18 : 20} />}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, onClick, tone = 'default', className }: { icon: IconName; label: string; onClick?: () => void; tone?: 'default' | 'brand'; className?: string }) {
  return (
    <button
      aria-label={label}
      onClick={() => {
        haptic.tap();
        onClick?.();
      }}
      className={cx(
        'inline-flex h-12 w-12 items-center justify-center rounded-full active:scale-95',
        tone === 'brand' ? 'bg-brand-soft text-brand' : 'text-muted',
        className,
      )}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={cx('inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent', className)} />;
}

// ── Card ──
export function Card({ children, className, onClick, padded = true }: { children: ReactNode; className?: string; onClick?: () => void; padded?: boolean }) {
  return (
    <div
      onClick={onClick ? () => (haptic.tap(), onClick()) : undefined}
      className={cx('rounded-[18px] bg-card shadow-card', padded && 'p-4', onClick && 'cursor-pointer active:scale-[0.99] transition', className)}
    >
      {children}
    </div>
  );
}

export function Section({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('mt-5', className)}>
      {(title || action) && (
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** A tappable list row (min 56px). */
export function Row({
  title,
  subtitle,
  right,
  left,
  onClick,
  chevron = !!onClick,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  left?: ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  className?: string;
}) {
  return (
    <div
      onClick={onClick ? () => (haptic.tap(), onClick()) : undefined}
      className={cx('flex min-h-[56px] items-center gap-3 px-4 py-2.5', onClick && 'cursor-pointer active:bg-card2', className)}
    >
      {left}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[16.5px] font-medium">{title}</div>
        {subtitle && <div className="truncate text-[14px] text-muted">{subtitle}</div>}
      </div>
      {right && <div className="shrink-0 text-right">{right}</div>}
      {chevron && <Icon name="chevron" size={18} className="text-muted" />}
    </div>
  );
}

export function List({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('divide-y divide-line overflow-hidden rounded-[18px] bg-card shadow-card', className)}>{children}</div>;
}

// ── Chip ──
export function Chip({ active, onClick, children, icon, tone }: { active?: boolean; onClick?: () => void; children: ReactNode; icon?: IconName; tone?: 'warn' | 'danger' }) {
  return (
    <button
      onClick={() => {
        haptic.tap();
        onClick?.();
      }}
      className={cx(
        'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-[15px] font-medium whitespace-nowrap transition',
        active ? 'bg-brand text-brand-ink' : tone === 'danger' ? 'bg-danger-soft text-danger' : tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-card text-text border border-line',
      )}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </button>
  );
}

export function Chips({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 py-1', className)}>{children}</div>;
}

// ── Stepper (big − / +). Long-press "+" calls onLongPress (e.g. add loose cans). ──
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 99999,
  label,
  onLongPress,
  size = 'lg',
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  label?: ReactNode;
  onLongPress?: () => void;
  size?: 'lg' | 'md';
}) {
  const timer = useRef<number | undefined>(undefined);
  const long = useRef(false);
  const h = size === 'lg' ? 'h-12 w-12' : 'h-10 w-10';
  const press = () => {
    long.current = false;
    if (onLongPress) {
      timer.current = window.setTimeout(() => {
        long.current = true;
        haptic.impact();
        onLongPress();
      }, 450);
    }
  };
  const release = () => window.clearTimeout(timer.current);
  return (
    <div className="flex items-center gap-1 select-none">
      <button
        aria-label="kamaytirish"
        disabled={value <= min}
        onClick={() => {
          haptic.tap();
          onChange(Math.max(min, value - 1));
        }}
        className={cx(h, 'flex items-center justify-center rounded-full bg-card2 text-text active:scale-90 disabled:opacity-30')}
      >
        <Icon name="minus" />
      </button>
      <div className="min-w-[44px] text-center">
        <div className="num text-[20px] leading-none font-bold">{value}</div>
        {label && <div className="mt-0.5 text-[11px] text-muted">{label}</div>}
      </div>
      <button
        aria-label="ko'paytirish"
        disabled={value >= max}
        onPointerDown={press}
        onPointerUp={release}
        onPointerLeave={release}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (long.current) return;
          haptic.tap();
          onChange(Math.min(max, value + 1));
        }}
        className={cx(h, 'flex items-center justify-center rounded-full bg-brand text-brand-ink active:scale-90 disabled:opacity-30')}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

// ── Status badge: icon + colour + word, always together ──
export type Tone = 'grey' | 'info' | 'warn' | 'ok' | 'danger' | 'brand' | 'accent';
const TONES: Record<Tone, string> = {
  grey: 'bg-grey-soft text-muted',
  info: 'bg-info-soft text-info',
  warn: 'bg-warn-soft text-warn',
  ok: 'bg-ok-soft text-ok',
  danger: 'bg-danger-soft text-danger',
  brand: 'bg-brand-soft text-brand',
  accent: 'bg-warn-soft text-accent-ink',
};

const STATUS: Record<string, Record<string, [string, Tone]>> = {
  order: { DRAFT: ['📝', 'grey'], CONFIRMED: ['✔️', 'info'], IN_TRANSIT: ['🚚', 'warn'], DELIVERED: ['✅', 'ok'], CANCELLED: ['⛔', 'danger'] },
  pay: { UNPAID: ['○', 'grey'], PARTIAL: ['◐', 'warn'], PAID: ['●', 'ok'], OVERDUE: ['⚠️', 'danger'] },
  shop: { LEAD: ['🌱', 'grey'], SAMPLE: ['🧃', 'info'], ORDERED: ['🛒', 'warn'], REGULAR: ['⭐', 'ok'], INACTIVE: ['💤', 'grey'] },
  supplier: { DRAFT: ['📝', 'grey'], ORDERED: ['📨', 'info'], IN_TRANSIT: ['🚚', 'warn'], RECEIVED: ['✅', 'ok'], CANCELLED: ['⛔', 'danger'] },
};
const LABEL_KEY = { order: 'orderStatus', pay: 'payStatus', shop: 'shopStatus', supplier: 'supplierStatus' } as const;

export function StatusBadge({ kind, status, small }: { kind: keyof typeof LABEL_KEY; status: string; small?: boolean }) {
  const [icon, tone] = STATUS[kind][status] ?? ['•', 'grey'];
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full font-semibold whitespace-nowrap', small ? 'px-2 py-0.5 text-[12px]' : 'px-2.5 py-1 text-[13px]', TONES[tone])}>
      <span aria-hidden>{icon}</span>
      {t(`${LABEL_KEY[kind]}.${status}` as never)}
    </span>
  );
}

export function Badge({ tone = 'grey', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold', TONES[tone])}>{children}</span>;
}

// ── Empty state & skeletons ──
export function EmptyState({ icon = 'layers', title, text, action }: { icon?: IconName; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-brand-soft text-brand">
        <Icon name={icon} size={30} />
      </div>
      <div className="text-[18px] font-semibold">{title}</div>
      {text && <div className="mt-1 max-w-[280px] text-[15px] text-muted">{text}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton rounded-[12px]', className)} />;
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-[68px]" />
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="rounded-[18px] bg-danger-soft p-4 text-danger">
      <div className="font-semibold">{error.message}</div>
      {onRetry && (
        <button className="mt-2 font-semibold underline" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

// ── Money and quantities ──
export function Money({ value, className, sign }: { value: number; className?: string; sign?: boolean }) {
  return <span className={cx('num whitespace-nowrap', className)}>{sign && value > 0 ? '+' : ''}{formatMoney(value)}</span>;
}

export function Qty({ cans, packSize, className }: { cans: number; packSize: number; className?: string }) {
  return <span className={cx('num whitespace-nowrap', className)}>{formatQty(cans, packSize)}</span>;
}

// ── Form fields ──
export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 px-1 text-[14px] font-medium text-muted">{label}</div>
      {children}
      {hint && !error && <div className="mt-1 px-1 text-[13px] text-muted">{hint}</div>}
      {error && <div className="mt-1 px-1 text-[13px] text-danger">{error}</div>}
    </label>
  );
}

export const inputClass =
  'h-[52px] w-full rounded-[14px] border border-line bg-card px-4 text-[17px] outline-none focus:border-brand placeholder:text-muted/70';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} className={cx(inputClass, 'h-auto py-3', props.className)} />;
}

/** Number input with "1 250 000" formatting and a numeric keyboard. */
export function MoneyInput({
  value,
  onChange,
  placeholder = '0',
  autoFocus,
  suffix = "so'm",
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
  suffix?: string;
}) {
  const shown = value == null ? '' : String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (
    <div className="relative">
      <input
        inputMode="numeric"
        autoFocus={autoFocus}
        value={shown}
        placeholder={placeholder}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 11);
          onChange(digits ? parseInt(digits, 10) : null);
        }}
        className={cx(inputClass, 'num pr-16 text-[19px] font-semibold')}
      />
      <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-muted">{suffix}</span>
    </div>
  );
}

export function NumberInput({ value, onChange, suffix, min = 0 }: { value: number | null; onChange: (v: number | null) => void; suffix?: string; min?: number }) {
  return (
    <div className="relative">
      <input
        inputMode="numeric"
        value={value ?? ''}
        onChange={(e) => {
          const d = e.target.value.replace(/[^\d]/g, '').slice(0, 7);
          onChange(d ? Math.max(min, parseInt(d, 10)) : null);
        }}
        className={cx(inputClass, 'num', suffix && 'pr-20')}
      />
      {suffix && <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-muted">{suffix}</span>}
    </div>
  );
}

/** Segmented choice (2–4 options). */
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex rounded-[14px] bg-card2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => {
            haptic.tap();
            onChange(o.value);
          }}
          className={cx('h-11 flex-1 rounded-[11px] text-[15px] font-semibold transition', value === o.value ? 'bg-card text-brand shadow-card' : 'text-muted')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        haptic.tap();
        onChange(!checked);
      }}
      className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left"
    >
      <div className="flex-1">
        <div className="text-[16.5px] font-medium">{label}</div>
        {hint && <div className="text-[13px] text-muted">{hint}</div>}
      </div>
      <span className={cx('relative h-7 w-12 rounded-full transition', checked ? 'bg-brand' : 'bg-line')}>
        <span className={cx('absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition', checked ? 'left-[22px]' : 'left-0.5')} />
      </span>
    </button>
  );
}

/** Big number tile for dashboards. */
export function Stat({ label, value, sub, tone, onClick }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'accent' | 'danger' | 'ok'; onClick?: () => void }) {
  return (
    <Card onClick={onClick} className="min-w-0">
      <div className="truncate text-[13px] font-medium text-muted">{label}</div>
      <div className={cx('num mt-1 truncate text-[22px] leading-tight font-bold', tone === 'accent' && 'text-brand', tone === 'danger' && 'text-danger', tone === 'ok' && 'text-ok')}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[13px] text-muted">{sub}</div>}
    </Card>
  );
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="relative">
      <Icon name="search" size={20} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t('common.search')}
        className={cx(inputClass, 'pl-12')}
        type="search"
      />
    </div>
  );
}
