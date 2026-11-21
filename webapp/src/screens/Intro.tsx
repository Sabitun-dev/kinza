import { useState } from 'react';
import { Button, cx } from '../ui/kit';
import { t } from '@shared/i18n';

const SLIDES = [
  { emoji: '⚡️', title: t('intro.s1Title'), text: t('intro.s1Text') },
  { emoji: '💰', title: t('intro.s2Title'), text: t('intro.s2Text') },
  { emoji: '📦', title: t('intro.s3Title'), text: t('intro.s3Text') },
];

/** 3-screen intro on first launch. */
export function Intro({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const s = SLIDES[i];
  const last = i === SLIDES.length - 1;
  return (
    <div className="flex min-h-screen flex-col bg-brand px-6 text-white">
      <div className="flex justify-end pt-4">
        {!last && (
          <button className="h-11 px-3 text-[15px] font-semibold text-white/80" onClick={onDone}>
            O'tkazib yuborish
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <div className="mb-8 flex h-32 w-32 items-center justify-center rounded-[36px] bg-white/10 text-[64px]">{s.emoji}</div>
        <div className="text-[13px] font-bold tracking-[0.2em] text-accent">KINZA DISTRO</div>
        <h1 className="mt-3 text-[28px] leading-tight font-bold">{s.title}</h1>
        <p className="mt-3 max-w-[300px] text-[17px] text-white/80">{s.text}</p>
      </div>
      <div className="mb-6 flex justify-center gap-2">
        {SLIDES.map((_, k) => (
          <span key={k} className={cx('h-2 rounded-full transition-all', k === i ? 'w-7 bg-accent' : 'w-2 bg-white/30')} />
        ))}
      </div>
      <div className="safe-bottom pb-4">
        <Button variant="accent" block onClick={() => (last ? onDone() : setI(i + 1))}>
          {last ? t('intro.start') : t('common.next')}
        </Button>
      </div>
    </div>
  );
}
