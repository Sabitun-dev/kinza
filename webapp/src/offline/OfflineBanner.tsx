import { useEffect, useState } from 'react';
import { t } from '@shared/i18n';

/** "Internet yo'q — saqlandi, keyin yuboriladi" + number of items waiting. */
export function OfflineBanner() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return <div className="sticky top-0 z-40 bg-warn px-4 py-2 text-center text-[14px] font-semibold text-white">📡 {t('common.offline')}</div>;
}
