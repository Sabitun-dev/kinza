import { useEffect, useState } from 'react';
import { t } from '@shared/i18n';
import { onQueueCount, startSync, flushQueue } from './queue';
import { useNav } from '../nav';

/** "Internet yo'q — saqlandi, keyin yuboriladi" + number of items waiting. */
export function OfflineBanner() {
  const nav = useNav();
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    startSync();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const unsub = onQueueCount(setPending);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      unsub();
    };
  }, []);
  if (online && pending === 0) return null;
  return (
    <button
      onClick={() => (online ? flushQueue() : nav.push('sync-queue'))}
      className={`sticky top-0 z-40 block w-full px-4 py-2 text-center text-[14px] font-semibold text-white ${online ? 'bg-info' : 'bg-warn'}`}
    >
      {online ? '🔄 ' : '📡 '}
      {online ? '' : t('common.offline')}
      {pending > 0 && <span className={online ? '' : 'ml-1'}>{online ? t('common.pending', { n: pending }) + ' · yuborish' : `· ${pending}`}</span>}
    </button>
  );
}
