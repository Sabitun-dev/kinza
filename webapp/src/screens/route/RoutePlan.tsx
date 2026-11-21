import { lazy, Suspense, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, EmptyState, Segmented, Skeleton, Spinner, cx } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { toast } from '../../ui/toast';
import { confirmDialog, haptic } from '../../tg';
import { getPosition } from '../../util';
import { formatMoney } from '@shared/money';
import type { ChecklistRow } from '../today/Checklist';

const ChecklistMap = lazy(() => import('../../map/ChecklistMap'));

export interface StoredRoute {
  stops: { itemId: number; shopId: number; name: string; lat: number; lng: number; etaMin: number; legKm: number }[];
  totalKm: number;
  totalMin: number;
  naiveKm: number;
  savedKm: number;
  fuelSaved: number;
  fuelCost: number;
  approximate: boolean;
  priorityFirst: boolean;
  path: [number, number][];
  start: { label: string } | null;
}

export const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

/** Route comparison: "Optimallashtirilgan: 38 km · Oddiy tartibda: 52 km · Tejaldi: 14 km ≈ 9 000 so'm". */
export function RouteSummary({ r }: { r: StoredRoute }) {
  return (
    <Card className="bg-brand text-brand-ink">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[13px] opacity-80">Optimallashtirilgan</div>
          <div className="num text-[26px] font-bold">{r.totalKm} km</div>
        </div>
        <div className="text-right text-[13px] opacity-80">≈ {Math.floor(r.totalMin / 60)} soat {r.totalMin % 60} daq</div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[13px]">
        <div>
          <div className="opacity-70">Oddiy tartibda</div>
          <div className="num font-semibold">{r.naiveKm} km</div>
        </div>
        <div>
          <div className="opacity-70">Tejaldi</div>
          <div className="num font-semibold text-accent">
            {r.savedKm} km ≈ {formatMoney(r.fuelSaved)}
          </div>
        </div>
      </div>
      {r.approximate && <div className="mt-2 text-[12px] opacity-80">ⓘ taxminiy: yo'l xizmati javob bermadi, to'g'ri chiziq × 1.3 olindi</div>}
    </Card>
  );
}

/** The day's route: order, ETA and km per stop; move stops by hand; recalculate. */
export function RoutePlanScreen() {
  const nav = useNav();
  const { data, reload } = useApi<any>('/checklist');
  const [busy, setBusy] = useState('');
  const [view, setView] = useState<'list' | 'map'>('list');
  const route: StoredRoute | null = data?.route ?? null;
  const items: ChecklistRow[] = data?.items ?? [];
  const pending = items.filter((i) => i.status === 'PENDING');

  const plan = async (body: object, label: string) => {
    setBusy(label);
    try {
      const r = await api.post(`/checklist/${data.id}/route`, body);
      invalidate('/checklist');
      await reload();
      return r as StoredRoute;
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy('');
    }
  };

  const fromHere = async () => {
    const pos = await getPosition(8000);
    const r = await plan({ start: pos }, 'here');
    if (r) toast(`Marshrut: ${r.totalKm} km ✅`);
  };

  const move = async (index: number, dir: -1 | 1) => {
    if (!route) return;
    haptic.tap();
    const order = route.stops.map((s) => s.itemId);
    const j = index + dir;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    const before = route.totalKm;
    const r = await plan({ order }, 'move');
    if (!r) return;
    const placed = Math.max(index, j) + 1;
    if (placed < order.length && (await confirmDialog(`Yangi tartib: ${r.totalKm} km (oldin ${before} km).\n\nQolganini qayta optimallashtiraymi?`))) {
      const r2 = await plan({ order, fixedCount: placed }, 'move');
      if (r2) toast(`Qayta hisoblandi: ${r2.totalKm} km`);
    }
  };

  useMainButton({ text: "🚗 Yo'lga chiqish", visible: pending.length > 0, onClick: () => nav.push('drive') });

  if (!data) return <Page title="Marshrut"><Skeleton className="h-80" /></Page>;
  if (!pending.length) return <Page title="Marshrut"><EmptyState icon="check" title="Bugun borilmagan do'kon qolmadi" /></Page>;
  return (
    <Page title="Marshrut" subtitle={`${pending.length} ta do'kon`}>
      {route ? <RouteSummary r={route} /> : <Card className="text-center text-muted">Marshrut hali hisoblanmagan</Card>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button size="md" icon="nav" loading={busy === 'here'} onClick={fromHere}>
          Joyimdan hisoblash
        </Button>
        <Segmented value={view} onChange={setView} options={[{ value: 'list', label: "Ro'yxat" }, { value: 'map', label: 'Xarita' }]} />
      </div>
      {view === 'map' && (
        <div className="mt-3">
          <Suspense fallback={<div className="flex h-[55vh] items-center justify-center"><Spinner /></div>}>
            <ChecklistMap items={pending} route={route} onOpen={(r) => nav.push('sell', { shopId: r.shopId, orderId: r.orderId ?? undefined })} />
          </Suspense>
        </div>
      )}
      {view === 'list' && route && (
        <div className="mt-3 space-y-2">
          {route.start && <div className="px-1 text-[13px] text-muted">🚩 Boshlanish: {route.start.label}</div>}
          {route.stops.map((s, i) => {
            const item = items.find((x) => x.id === s.itemId);
            return (
              <Card key={s.itemId} className={cx('flex items-center gap-3 py-3', busy === 'move' && 'opacity-60')}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-[15px] font-bold text-brand-ink">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-bold">{s.name}</span>
                    {item?.source === 'CARRY' && <Badge tone="danger">Kecha qolgan</Badge>}
                    {item?.source === 'PREORDER' && <Badge tone="accent">📦</Badge>}
                  </div>
                  <div className="text-[13px] text-muted">
                    ~{hhmm(s.etaMin)} · +{s.legKm} km{item?.shop.openTo ? ` · ${item.shop.openFrom ?? ''}–${item.shop.openTo}` : ''}
                  </div>
                </div>
                <div className="flex flex-col">
                  <button aria-label="Yuqoriga" disabled={i === 0} className="flex h-9 w-10 items-center justify-center text-muted disabled:opacity-20" onClick={() => move(i, -1)}>
                    <Icon name="chevronDown" className="rotate-180" />
                  </button>
                  <button aria-label="Pastga" disabled={i === route.stops.length - 1} className="flex h-9 w-10 items-center justify-center text-muted disabled:opacity-20" onClick={() => move(i, 1)}>
                    <Icon name="chevronDown" />
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </Page>
  );
}
