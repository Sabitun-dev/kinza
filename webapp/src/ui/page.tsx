import type { ReactNode } from 'react';
import { supports } from '../tg';
import { useGoBack, useNav } from '../nav';
import { Icon } from './icons';
import { cx } from './kit';

/** Screen layout: title bar + content. Sub-screens leave room for the MainButton fallback. */
export function Page({
  title,
  subtitle,
  right,
  children,
  bottomPad = true,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  bottomPad?: boolean;
  className?: string;
}) {
  const nav = useNav();
  const back = useGoBack();
  const showBack = !supports.backButton && nav.stack.length > 1;
  return (
    <div className={cx('min-h-screen', bottomPad ? 'pb-28' : 'pb-6', className)}>
      {(title || right) && (
        <header className="sticky top-0 z-20 flex min-h-[56px] items-center gap-1 bg-bg/95 px-4 py-2 backdrop-blur">
          {showBack && (
            <button onClick={back} aria-label="Orqaga" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-brand">
              <Icon name="back" size={24} />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[22px] leading-tight font-bold">{title}</h1>
            {subtitle && <div className="truncate text-[14px] text-muted">{subtitle}</div>}
          </div>
          {right}
        </header>
      )}
      <div className="px-4">{children}</div>
    </div>
  );
}
