import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Chip, Chips, Skeleton, Spinner, TextInput, cx } from '../../ui/kit';
import { Sheet, ChoiceSheet } from '../../ui/sheet';
import { Icon } from '../../ui/icons';
import { api, invalidate, prefetch } from '../../api';
import { useMainButton } from '../../mainButton';
import { useIsActive, useNav, useGoBack } from '../../nav';
import { toast } from '../../ui/toast';
import { haptic } from '../../tg';
import { addDays, callPhone, distanceM, localDate, navChoice, openNavigation, readLocation, type NavApp } from '../../util';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';
import { hhmm } from './RoutePlan';
import { nextFriday } from '../today/Checklist';

const DriveMap = lazy(() => import('../../map/DriveMap'));

type Pos = { lat: number; lng: number; accuracy?: number };
const GPS_EVERY_MS = 45_000;
const ARRIVE_M = 150;
const OFF_ROUTE_M = 1000;

// Saved on the phone so driving mode works offline and resumes after the app is closed.
const KEY = (d: string) => `drive:${d}`;
interface Saved {
  checklistId: number;
  bundle: any;
  done: number[]; // shop ids finished (also those queued offline)
  gpsQueue: { lat: number; lng: number; accuracy: number; at: string }[];
}
const load = (d: string): Saved | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY(d)) ?? 'null');
  } catch {
    return null;
  }
};
const save = (d: string, s: Saved) => {
  try {
    localStorage.setItem(KEY(d), JSON.stringify(s));
    localStorage.setItem('drive:active', d);
  } catch {
    /* storage full / blocked */
  }
};
export const activeDriveDay = () => {
  try {
    return localStorage.getItem('drive:active');
  } catch {
    return null;
  }
};
const clearActive = () => {
  try {
    localStorage.removeItem('drive:active');
  } catch {
    /* ignore */
  }
};

/** Tells driving mode that a shop is finished (called by Sotish, also when saved offline). */
export function markShopDone(shopId: number) {
  const d = localDate();
  const s = load(d);
  if (s && !s.done.includes(shopId)) save(d, { ...s, done: [...s.done, shopId] });
  window.dispatchEvent(new CustomEvent('kinza:shop-done', { detail: shopId }));
}

/** "Yo'lga chiqish": one stop at a time, in route order. */
export function DriveScreen() {
  const nav = useNav();
  const back = useGoBack();
  const active = useIsActive();
  const today = localDate();
  const [state, setState] = useState<Saved | null>(() => load(today));
  const [me, setMe] = useState<Pos | null>(null);
  const [busy, setBusy] = useState('');
  const [sheet, setSheet] = useState<'' | 'skip' | 'move' | 'nav'>('');
  const [moveDate, setMoveDate] = useState(addDays(today, 1));
  const [moveReason, setMoveReason] = useState('');
  const [suggestReplan, setSuggestReplan] = useState(false);
  const [finish, setFinish] = useState<any>(null);
  const lastStop = useRef<number | null>(null);

  const update = useCallback((patch: Partial<Saved>) => {
    setState((s) => {
      if (!s) return s;
      const next = { ...s, ...patch };
      save(today, next);
      return next;
    });
  }, [today]);

  // Start: plan from my position and keep the bundle on the phone
  useEffect(() => {
    if (state) return;
    (async () => {
      setBusy('start');
      try {
        const list = await api.get('/checklist');
        if (!list.id) throw new Error("Bugun ro'yxat yo'q");
        const pos = await readLocation();
        if (pos) setMe(pos);
        const bundle = await api.post(`/checklist/${list.id}/drive/start`, { start: pos ? { lat: pos.lat, lng: pos.lng } : null });
        const s: Saved = { checklistId: list.id, bundle, done: [], gpsQueue: [] };
        save(today, s);
        setState(s);
        haptic.success();
        // Keep every stop's Sotish form on the phone, so selling works without internet
        for (const st of bundle.stops.filter((x: any) => x.status === 'PENDING')) {
          prefetch(`/sell-form?shopId=${st.shopId}${st.orderId ? `&orderId=${st.orderId}` : ''}`).catch(() => {});
        }
        prefetch('/car').catch(() => {});
      } catch (e) {
        toast.error(e);
        back();
      } finally {
        setBusy('');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh from the server when coming back to this screen (e.g. after Sotish)
  const refresh = useCallback(async () => {
    if (!state) return;
    try {
      const bundle = await api.get(`/checklist/${state.checklistId}/drive`);
      update({ bundle });
    } catch {
      /* offline: keep the saved bundle */
    }
  }, [state, update]);
  useEffect(() => {
    if (active && state) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    const onDone = (e: Event) => {
      const shopId = (e as CustomEvent<number>).detail;
      setState((s) => (s && !s.done.includes(shopId) ? { ...s, done: [...s.done, shopId] } : s));
    };
    window.addEventListener('kinza:shop-done', onDone);
    return () => window.removeEventListener('kinza:shop-done', onDone);
  }, []);

  // Stops still to visit, in route order
  const stops: any[] = useMemo(() => {
    if (!state) return [];
    const b = state.bundle;
    const byItem = new Map(b.stops.map((s: any) => [s.id, s]));
    const order: any[] = b.route?.stops?.map((r: any) => byItem.get(r.itemId)).filter(Boolean) ?? b.stops;
    const rest = b.stops.filter((s: any) => !order.includes(s));
    return [...order, ...rest].filter((s: any) => s.status === 'PENDING' && !state.done.includes(s.shopId));
  }, [state]);
  const total = state?.bundle.stops.length ?? 0;
  const next = stops[0] ?? null;
  const number = total - stops.length + 1;
  const eta = next && state?.bundle.route?.stops?.find((r: any) => r.itemId === next.id)?.etaMin;

  // Next stop changed → haptic + animation
  useEffect(() => {
    if (next && lastStop.current !== null && lastStop.current !== next.id) {
      haptic.success();
      setSuggestReplan(false);
    }
    lastStop.current = next?.id ?? null;
  }, [next]);

  // GPS while this screen is open (never in the background): position, km, arrival hint
  useEffect(() => {
    if (!active || !state) return;
    let stopped = false;
    const tick = async () => {
      const p = await readLocation();
      if (stopped || !p) return;
      setMe(p);
      setState((s) => {
        if (!s) return s;
        const n = { ...s, gpsQueue: [...s.gpsQueue, { lat: p.lat, lng: p.lng, accuracy: p.accuracy, at: new Date().toISOString() }].slice(-500) };
        save(today, n);
        return n;
      });
    };
    tick();
    const id = setInterval(tick, GPS_EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, !!state]);

  // Send GPS points in batches (kept on the phone while offline)
  useEffect(() => {
    if (!state || state.gpsQueue.length < 2) return;
    const batch = state.gpsQueue;
    api
      .post(`/checklist/${state.checklistId}/gps`, { points: batch })
      .then(() => setState((s) => (s ? (save(today, { ...s, gpsQueue: s.gpsQueue.slice(batch.length) }), { ...s, gpsQueue: s.gpsQueue.slice(batch.length) }) : s)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.gpsQueue.length]);

  // More than 1 km off the planned order: another stop is much closer than the next one
  const dNext = me && next?.shop.lat ? distanceM(me, { lat: next.shop.lat, lng: next.shop.lng }) : null;
  const offRoute =
    !!me && dNext != null && stops.slice(1).some((s) => s.shop.lat && distanceM(me, { lat: s.shop.lat, lng: s.shop.lng }) + OFF_ROUTE_M < dNext);
  const arrived = dNext != null && dNext <= ARRIVE_M;

  const replan = async () => {
    if (!state) return;
    setBusy('replan');
    try {
      const pos = me ?? (await readLocation());
      await api.post(`/checklist/${state.checklistId}/route`, { start: pos ? { lat: pos.lat, lng: pos.lng } : null });
      await refresh();
      setSuggestReplan(false);
      toast('Marshrut qayta hisoblandi ✅');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy('');
    }
  };

  const openSell = () => next && nav.push('sell', { shopId: next.shopId, orderId: next.orderId ?? undefined, fromDrive: true });

  const doNav = (app?: NavApp) => {
    if (!next?.shop.lat) return toast.error('Joylashuv yo‘q');
    const choice = app ?? navChoice.get();
    if (!choice) return setSheet('nav');
    navChoice.set(choice);
    openNavigation(next.shop.lat, next.shop.lng, choice);
  };

  const skip = async (kind: 'closed' | 'later' | 'move') => {
    if (!state || !next) return;
    setSheet('');
    setBusy('skip');
    try {
      if (kind === 'closed') {
        await api.post(`/checklist/items/${next.id}/closed`, { pos: me ? { lat: me.lat, lng: me.lng } : null });
        markShopDone(next.shopId);
      } else if (kind === 'later') {
        await api.post(`/checklist/${state.checklistId}/route`, { later: next.id });
      } else {
        await api.post(`/checklist/items/${next.id}/move`, { date: moveDate, reason: moveReason });
        markShopDone(next.shopId);
      }
      await refresh();
      invalidate('/checklist');
      setSuggestReplan(kind !== 'later');
    } catch (e) {
      if ((e as any).code === 'offline' && kind === 'closed') {
        markShopDone(next.shopId);
        toast("Internet yo'q — keyin yuboriladi");
      } else toast.error(e);
    } finally {
      setBusy('');
    }
  };

  // All done → end screen
  useEffect(() => {
    if (!state || stops.length || finish) return;
    api
      .post(`/checklist/${state.checklistId}/drive/finish`, {})
      .then(setFinish)
      .catch(() => setFinish({ offline: true, done: total, total }));
    clearActive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops.length, !!state]);

  useMainButton({
    text: finish ? '🏁 Kun yakuni' : arrived ? '📍 Yetib keldim — Sotish' : '📍 Yetib keldim',
    visible: !!state && (!!next || !!finish),
    color: arrived ? 'accent' : 'brand',
    onClick: () => (finish ? nav.replace('day-close') : openSell()),
  });

  if (!state) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <Spinner className="h-8 w-8 text-brand" />
        <div className="text-[17px] font-semibold">Marshrut hisoblanmoqda…</div>
        <div className="text-[14px] text-muted">Joylashuvingiz va yo'llar bo'yicha eng qisqa tartib</div>
      </div>
    );
  }

  if (finish) {
    return (
      <div className="min-h-screen px-4 pt-6 pb-28">
        <div className="text-center text-[44px]">🏁</div>
        <h1 className="text-center text-[24px] font-bold">Marshrut tugadi</h1>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Card>
            <div className="text-[13px] text-muted">Do'konlar</div>
            <div className="text-[22px] font-bold">{finish.done} / {finish.total}</div>
          </Card>
          <Card>
            <div className="text-[13px] text-muted">Yig'ildi</div>
            <div className="num text-[18px] font-bold">{formatMoney(finish.collected ?? 0)}</div>
          </Card>
          <Card>
            <div className="text-[13px] text-muted">Km: reja / yurildi</div>
            <div className="num text-[20px] font-bold">{finish.plannedKm ?? '—'} / {finish.drivenKm ?? '—'}</div>
          </Card>
          <Card>
            <div className="text-[13px] text-muted">Yoqilg'i (taxminan)</div>
            <div className="num text-[18px] font-bold">{formatMoney(finish.fuel ?? 0)}</div>
          </Card>
        </div>
        {finish.expenseId && <div className="mt-3 text-center text-[13px] text-muted">Yoqilg'i xarajatlarga avtomatik yozildi (tahrirlash mumkin).</div>}
        <Button block variant="secondary" className="mt-5" onClick={() => nav.pop()}>Ro'yxatga qaytish</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 pt-3 pb-28">
      <div className="flex items-center justify-between">
        <button className="flex h-11 items-center gap-1 text-[15px] font-semibold text-muted" onClick={() => nav.pop()}>
          <Icon name="back" size={20} /> Ro'yxat
        </button>
        <span className="rounded-full bg-brand px-3 py-1 text-[15px] font-bold text-brand-ink">
          {number} / {total}
        </span>
      </div>

      {(offRoute || suggestReplan) && (
        <button onClick={replan} className="mt-2 flex w-full items-center justify-center gap-2 rounded-[14px] bg-info-soft p-3 text-[15px] font-semibold text-info">
          {busy === 'replan' ? <Spinner /> : <Icon name="refresh" size={18} />} Marshrutni qayta hisoblash
        </button>
      )}
      {arrived && (
        <button onClick={openSell} className="animate-toast mt-2 w-full rounded-[14px] bg-accent p-3 text-[16px] font-bold text-accent-ink">
          📍 Yetib keldingizmi? — Sotishni ochish
        </button>
      )}

      {next && (
        <div key={next.id} className="animate-toast">
          <Card className="mt-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-[24px] leading-tight font-bold">{next.shop.name}</div>
                <div className="mt-0.5 text-[15px] text-muted">{next.shop.address ?? next.shop.area ?? ''}</div>
                {next.shop.notes && <div className="mt-1 text-[14px]">📌 {next.shop.notes}</div>}
              </div>
              {next.source === 'CARRY' && <Badge tone="danger">Kecha qolgan</Badge>}
              {next.source === 'PREORDER' && <Badge tone="accent">📦 Buyurtma</Badge>}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-[12px] bg-card2 p-2">
                <div className="text-[12px] text-muted">Masofa</div>
                <div className="num font-bold">{dNext != null ? (dNext < 1000 ? `${Math.round(dNext * 1.3)} m` : `${((dNext * 1.3) / 1000).toFixed(1)} km`) : '—'}</div>
              </div>
              <div className="rounded-[12px] bg-card2 p-2">
                <div className="text-[12px] text-muted">Yetib borish</div>
                <div className="num font-bold">{dNext != null ? `${Math.max(1, Math.round((dNext * 1.3) / 500))} daq` : eta ? hhmm(eta) : '—'}</div>
              </div>
              <div className={cx('rounded-[12px] p-2', next.balance > 0 ? 'bg-danger-soft' : 'bg-card2')}>
                <div className="text-[12px] text-muted">Qarz</div>
                <div className={cx('num text-[14px] font-bold', next.balance > 0 && 'text-danger')}>{next.balance > 0 ? formatMoney(next.balance).replace(" so'm", '') : '0'}</div>
              </div>
            </div>
            {next.lastOrder && (
              <div className="mt-3 text-[14px]">
                <span className="text-muted">Oldingi safar: </span>
                {next.lastOrder.lines.map((l: any) => `${l.flavour} ${formatQty(l.qtyCans, l.packSize)}${l.isBonus ? ' 🎁' : ''}`).join(', ')}
              </div>
            )}
          </Card>

          <div className="mt-3">
            <Suspense fallback={<Skeleton className="h-44" />}>
              <DriveMap me={me} next={next.shop.lat ? { lat: next.shop.lat, lng: next.shop.lng } : null} rest={stops.slice(1).filter((s) => s.shop.lat).map((s) => ({ lat: s.shop.lat, lng: s.shop.lng }))} />
            </Suspense>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button variant="primary" icon="nav" onClick={() => doNav()}>
              Yo'nalish
            </Button>
            <Button variant="secondary" icon="phone" disabled={!next.shop.phones?.[0]} onClick={() => callPhone(next.shop.phones[0])}>
              Qo'ng'iroq
            </Button>
            <Button variant="secondary" loading={busy === 'skip'} onClick={() => setSheet('skip')} className="col-span-2">
              ⏭ O'tkazib yuborish
            </Button>
          </div>
          {stops.length > 1 && (
            <div className="mt-4 text-[13px] text-muted">
              Keyingilari: {stops.slice(1, 5).map((s) => s.shop.name).join(' → ')}
              {stops.length > 5 ? ' …' : ''}
            </div>
          )}
          <button className="mt-2 text-[13px] font-semibold text-brand" onClick={() => setSheet('nav')}>
            Navigator: {navChoice.get() === 'google' ? 'Google Maps' : navChoice.get() === 'yandex' ? 'Yandex Xaritalar' : navChoice.get() === 'yandexnavi' ? 'Yandex Navigator' : 'tanlanmagan'} ›
          </button>
        </div>
      )}

      <Sheet open={sheet === 'skip'} onClose={() => setSheet('')} title={`O'tkazib yuborish: ${next?.shop.name ?? ''}`}>
        <div className="space-y-2">
          <Button block variant="secondary" onClick={() => skip('closed')}>🔒 Yopiq ekan</Button>
          <Button block variant="secondary" onClick={() => skip('later')}>↩️ Keyinroq qaytaman</Button>
          <Button block variant="secondary" onClick={() => setSheet('move')}>📅 Boshqa kunga</Button>
        </div>
      </Sheet>
      <Sheet open={sheet === 'move'} onClose={() => setSheet('')} title="Boshqa kunga">
        <div className="space-y-3">
          <Chips>
            <Chip active={moveDate === addDays(today, 1)} onClick={() => setMoveDate(addDays(today, 1))}>Ertaga</Chip>
            <Chip active={moveDate === nextFriday()} onClick={() => setMoveDate(nextFriday())}>Juma</Chip>
            <Chip active={moveDate === addDays(today, 7)} onClick={() => setMoveDate(addDays(today, 7))}>Keyingi hafta</Chip>
          </Chips>
          <TextInput placeholder="Sabab (majburiy)" value={moveReason} onChange={(e) => setMoveReason(e.target.value)} />
          <Button block disabled={!moveReason.trim()} onClick={() => skip('move')}>Ko'chirish</Button>
        </div>
      </Sheet>
      <ChoiceSheet
        open={sheet === 'nav'}
        onClose={() => setSheet('')}
        title="Qaysi navigator?"
        value={navChoice.get()}
        options={[
          { value: 'yandexnavi', label: 'Yandex Navigator', sub: "Ilova ochilmasa — Yandex Xaritalar" },
          { value: 'yandex', label: 'Yandex Xaritalar (veb)' },
          { value: 'google', label: 'Google Maps' },
        ]}
        onPick={(v) => doNav(v as NavApp)}
      />
    </div>
  );
}
