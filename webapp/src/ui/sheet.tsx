import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBackHandler } from '../nav';
import { cx } from './kit';

/** Bottom sheet. The Telegram BackButton closes it. */
export function Sheet({ open, onClose, title, children, footer, tall }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; tall?: boolean }) {
  useBackHandler(onClose, open);
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div className="animate-fade absolute inset-0 bg-black/40" onClick={onClose} />
      <div className={cx('animate-sheet relative flex max-h-[92vh] flex-col rounded-t-[22px] bg-bg', tall && 'h-[92vh]')}>
        <div className="flex justify-center pt-2.5 pb-1">
          <div className="h-1.5 w-10 rounded-full bg-line" />
        </div>
        {title && <div className="px-5 pt-1 pb-3 text-[19px] font-bold">{title}</div>}
        <div className="flex-1 overflow-y-auto px-4 pb-4">{children}</div>
        {footer && <div className="border-t border-line bg-bg px-4 pt-3 safe-bottom">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A sheet with a list of choices. */
export function ChoiceSheet<T extends string | number>({
  open,
  onClose,
  title,
  options,
  value,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  options: { value: T; label: ReactNode; sub?: ReactNode }[];
  value?: T | null;
  onPick: (v: T) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className="divide-y divide-line overflow-hidden rounded-[18px] bg-card">
        {options.map((o) => (
          <button
            key={String(o.value)}
            onClick={() => {
              onPick(o.value);
              onClose();
            }}
            className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left active:bg-card2"
          >
            <div className="flex-1">
              <div className="text-[16.5px] font-medium">{o.label}</div>
              {o.sub && <div className="text-[13px] text-muted">{o.sub}</div>}
            </div>
            {value === o.value && <span className="text-[20px] text-brand">✓</span>}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
