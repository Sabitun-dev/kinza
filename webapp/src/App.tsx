import { Suspense, useCallback, useEffect, useState } from 'react';
import { api, ApiError, invalidate } from './api';
import { inTelegram, startParam } from './tg';
import { NavProvider, useNav, ActiveProvider, type TabName } from './nav';
import { SessionCtx, useSession, type Session } from './session';
import { MainButtonFallback } from './mainButton';
import { Toaster, toast } from './ui/toast';
import { Button, EmptyState, Spinner, cx } from './ui/kit';
import { Icon, type IconName } from './ui/icons';
import { Sheet } from './ui/sheet';
import { Intro } from './screens/Intro';
import { SCREENS } from './screens/registry';
import { OfflineBanner } from './offline/OfflineBanner';
import { t } from '@shared/i18n';

type Boot = { state: 'loading' } | { state: 'error'; error: ApiError } | { state: 'noaccess'; id?: number } | { state: 'ready'; session: Omit<Session, 'reload'> };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });

  const load = useCallback(async () => {
    try {
      const sp = startParam();
      let me = await api.get('/me');
      if (!me.user && sp?.startsWith('inv_')) {
        await api.post('/invites/accept', { token: sp.slice(4) });
        me = await api.get('/me');
        toast(t('common.done'));
      }
      if (!me.user) return setBoot({ state: 'noaccess' });
      setBoot({ state: 'ready', session: { user: me.user, settings: me.settings } });
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'invite_invalid') return setBoot({ state: 'error', error: err });
      setBoot({ state: 'error', error: err });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (boot.state === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center text-brand">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  if (boot.state === 'noaccess' || boot.state === 'error') {
    const msg = boot.state === 'error' ? (inTelegram ? boot.error.message : t('common.openInTelegram')) : t('common.noAccess');
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <EmptyState icon="user" title="KINZA DISTRO" text={msg} action={boot.state === 'error' ? <Button onClick={load}>{t('common.retry')}</Button> : undefined} />
      </div>
    );
  }

  const session: Session = {
    ...boot.session,
    reload: async () => {
      const me = await api.get('/me');
      invalidate('');
      setBoot({ state: 'ready', session: { user: me.user, settings: me.settings } });
    },
  };
  return (
    <SessionCtx.Provider value={session}>
      {!session.user.introSeen ? (
        <Intro
          onDone={async () => {
            await api.post('/me/intro-seen').catch(() => {});
            session.user.introSeen = true;
            setBoot({ state: 'ready', session: { ...boot.session, user: { ...boot.session.user, introSeen: true } } });
          }}
        />
      ) : (
        <NavProvider>
          <Shell />
        </NavProvider>
      )}
      <Toaster />
      <MainButtonFallback />
    </SessionCtx.Provider>
  );
}

/** Opens the screen a deep link points to: o_12 order, s_5 shop, p_5 payment, d_12 delivery… */
function useDeepLink() {
  const nav = useNav();
  useEffect(() => {
    const sp = startParam();
    if (!sp || sp.startsWith('inv_')) return;
    const [kind, raw] = sp.split('_');
    const id = Number(raw);
    const map: Record<string, [TabName, string?, any?]> = {
      o: ['orders', 'order', { id }],
      d: ['orders', 'deliver', { id }],
      s: ['shops', 'shop', { id }],
      p: ['more', 'payment-new', { shopId: id || undefined }],
      so: ['stock', 'supplier-order', { id }],
      tashkent: ['stock', 'supplier-proposal'],
      debtors: ['more', 'debtors'],
      reminders: ['more', 'reminders'],
      route: ['today', 'route'],
      stock: ['stock'],
      today: ['today'],
    };
    const target = map[kind] ?? map[sp];
    if (target) nav.open(target[0], target[1], target[2]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const TABS: { name: TabName; icon: IconName; label: string; roles?: string[] }[] = [
  { name: 'today', icon: 'today', label: t('tabs.today') },
  { name: 'orders', icon: 'orders', label: t('tabs.orders') },
  { name: 'shops', icon: 'shops', label: t('tabs.shops'), roles: ['OWNER', 'AGENT'] },
  { name: 'stock', icon: 'stock', label: t('tabs.stock') },
  { name: 'more', icon: 'more', label: t('tabs.more') },
];

function Shell() {
  const nav = useNav();
  const [plusOpen, setPlusOpen] = useState(false);
  useDeepLink();
  const top = nav.stack.length - 1;
  const onRoot = nav.stack.length === 1;

  return (
    <>
      <OfflineBanner />
      {nav.stack.map((route, i) => {
        const Screen = SCREENS[route.name] ?? SCREENS['not-found'];
        return (
          <div key={route.key} style={{ display: i === top ? 'block' : 'none' }}>
            <ActiveProvider value={i === top}>
              <Suspense fallback={<div className="flex h-screen items-center justify-center text-brand"><Spinner /></div>}>
                <Screen {...(route.params ?? {})} />
              </Suspense>
            </ActiveProvider>
          </div>
        );
      })}
      {onRoot && <TabBar onPlus={() => setPlusOpen(true)} />}
      <PlusSheet open={plusOpen} onClose={() => setPlusOpen(false)} />
    </>
  );
}

function TabBar({ onPlus }: { onPlus: () => void }) {
  const nav = useNav();
  const { user } = useSession();
  const tabs = TABS.filter((tb) => !tb.roles || tb.roles.includes(user.role));
  return (
    <>
      <button
        aria-label={t('plus.title')}
        onClick={onPlus}
        className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom)+80px)] z-30 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_6px_20px_rgba(232,163,23,0.45)] active:scale-95"
      >
        <Icon name="plus" size={30} strokeWidth={2.5} />
      </button>
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-card/95 backdrop-blur safe-bottom">
        <div className="flex">
          {tabs.map((tb) => {
            const active = nav.tab === tb.name;
            return (
              <button
                key={tb.name}
                onClick={() => nav.setTab(tb.name)}
                className={cx('flex h-[60px] flex-1 flex-col items-center justify-center gap-0.5 text-[11.5px] font-semibold', active ? 'text-brand' : 'text-muted')}
              >
                <span className={cx('flex h-8 w-14 items-center justify-center rounded-full transition', active && 'bg-brand-soft')}>
                  <Icon name={tb.icon} size={23} strokeWidth={active ? 2.4 : 2} />
                </span>
                {tb.label}
              </button>
            );
          })}
        </div>
      </nav>
    </>
  );
}

function PlusSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNav();
  const { user } = useSession();
  const items: { icon: IconName; label: string; screen: string; roles: string[] }[] = [
    { icon: 'orders', label: t('plus.order'), screen: 'order-new', roles: ['OWNER', 'AGENT'] },
    { icon: 'shops', label: t('plus.shop'), screen: 'shop-edit', roles: ['OWNER', 'AGENT'] },
    { icon: 'wallet', label: t('plus.payment'), screen: 'payment-new', roles: ['OWNER', 'AGENT', 'DRIVER'] },
    { icon: 'pin', label: t('plus.visit'), screen: 'visit-new', roles: ['OWNER', 'AGENT'] },
    { icon: 'receipt', label: t('plus.expense'), screen: 'expense-edit', roles: ['OWNER'] },
  ];
  return (
    <Sheet open={open} onClose={onClose} title={t('plus.title')}>
      <div className="grid grid-cols-2 gap-3">
        {items
          .filter((i) => i.roles.includes(user.role))
          .map((i, idx) => (
            <button
              key={i.screen}
              onClick={() => {
                onClose();
                nav.push(i.screen);
              }}
              className={cx(
                'flex min-h-[88px] flex-col items-start justify-between rounded-[18px] p-4 text-left text-[16px] font-semibold active:scale-[0.98]',
                idx === 0 ? 'col-span-2 bg-brand text-brand-ink' : 'bg-card shadow-card',
              )}
            >
              <Icon name={i.icon} size={26} />
              {i.label}
            </button>
          ))}
      </div>
    </Sheet>
  );
}
