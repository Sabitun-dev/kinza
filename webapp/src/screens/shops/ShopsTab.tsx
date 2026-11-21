import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Page } from '../../ui/page';
import { Chip, Chips, EmptyState, ErrorBox, List, Money, Row, SearchInput, SkeletonList, StatusBadge, Spinner, Segmented, useDebounced, Button } from '../../ui/kit';
import { useApi } from '../../api';
import { useNav } from '../../nav';
import { roughPosition, ago } from '../../util';
import { t } from '@shared/i18n';

const ShopsMap = lazy(() => import('../../map/ShopsMap'));

export interface ShopListItem {
  id: number;
  name: string;
  contactName: string | null;
  phones: string[];
  address: string | null;
  lat: number | null;
  lng: number | null;
  status: string;
  district: { id: number; name: string } | null;
  balance: number;
  overdue: number;
  lastOrderAt: string | null;
  distanceKm: number | null;
  agentName: string | null;
  visitLate?: boolean;
  missing?: string[];
}

type Filter = 'all' | 'debt' | 'overdue' | 'LEAD' | 'REGULAR' | 'INACTIVE';

export function ShopsTab() {
  const nav = useNav();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [filter, setFilter] = useState<Filter>('all');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    roughPosition().then(setPos);
  }, []);
  const path = `/shops?q=${encodeURIComponent(dq)}${pos ? `&lat=${pos.lat.toFixed(4)}&lng=${pos.lng.toFixed(4)}` : ''}`;
  const { data, error, loading, reload } = useApi<{ shops: ShopListItem[] }>(path);

  const shops = useMemo(() => {
    const all = data?.shops ?? [];
    switch (filter) {
      case 'debt':
        return all.filter((s) => s.balance > 0).sort((a, b) => b.balance - a.balance);
      case 'overdue':
        return all.filter((s) => s.overdue > 0).sort((a, b) => b.overdue - a.overdue);
      case 'LEAD':
        return all.filter((s) => s.status === 'LEAD' || s.status === 'SAMPLE');
      case 'REGULAR':
      case 'INACTIVE':
        return all.filter((s) => s.status === filter);
      default:
        return all;
    }
  }, [data, filter]);

  return (
    <Page
      title={t('tabs.shops')}
      subtitle={data ? `${data.shops.length} ta do'kon` : undefined}
      right={
        <div className="w-[150px]">
          <Segmented value={view} onChange={setView} options={[{ value: 'list', label: "Ro'yxat" }, { value: 'map', label: 'Xarita' }]} />
        </div>
      }
    >
      <SearchInput value={q} onChange={setQ} placeholder="Do'kon, mo'ljal yoki telefon…" />
      <Chips className="mt-3">
        {(
          [
            ['all', t('common.all')],
            ['debt', 'Qarzdor'],
            ['overdue', "Muddati o'tgan"],
            ['LEAD', 'Leadlar'],
            ['REGULAR', 'Doimiy'],
            ['INACTIVE', 'Nofaol'],
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <Chip key={k} active={filter === k} onClick={() => setFilter(k)}>
            {label}
          </Chip>
        ))}
      </Chips>
      <div className="mt-3">
        {error && <ErrorBox error={error} onRetry={reload} />}
        {loading && <SkeletonList />}
        {data && shops.length === 0 && (
          <EmptyState
            icon="shops"
            title={q ? 'Topilmadi' : "Hozircha do'kon yo'q"}
            text={q ? undefined : "Birinchi do'konni qo'shing. Do'konda turib, joylashuvni bir tugma bilan saqlaysiz."}
            action={!q ? <Button icon="plus" onClick={() => nav.push('shop-edit')}>Yangi do'kon</Button> : undefined}
          />
        )}
        {data && shops.length > 0 && view === 'list' && (
          <List>
            {shops.map((s) => (
              <ShopRow key={s.id} s={s} onClick={() => nav.push('shop', { id: s.id })} />
            ))}
          </List>
        )}
        {data && view === 'map' && (
          <Suspense fallback={<div className="flex h-[60vh] items-center justify-center"><Spinner /></div>}>
            <ShopsMap shops={shops} me={pos} onOpen={(id) => nav.push('shop', { id })} />
          </Suspense>
        )}
      </div>
    </Page>
  );
}

export function ShopRow({ s, onClick }: { s: ShopListItem; onClick: () => void }) {
  const sub = [s.distanceKm != null ? `${s.distanceKm < 1 ? Math.round(s.distanceKm * 1000) + ' m' : s.distanceKm.toFixed(1) + ' km'}` : null, s.district?.name ?? s.address, s.lastOrderAt ? `oxirgi: ${ago(s.lastOrderAt)}` : null]
    .filter(Boolean)
    .join(' · ');
  const red = s.visitLate || (s.missing?.length ?? 0) > 0;
  return (
    <Row
      onClick={onClick}
      className={red ? 'bg-danger-soft' : undefined}
      title={red ? <span className="text-danger">{s.name}{s.missing?.length ? ` · ${s.missing.join(', ')} yo'q` : ' · uzoq borilmagan'}</span> : s.name}
      subtitle={sub || t(`shopStatus.${s.status}` as never)}
      right={
        s.balance > 0 ? (
          <div>
            <Money value={s.balance} className={s.overdue > 0 ? 'font-semibold text-danger' : 'font-semibold'} />
            {s.overdue > 0 && <div className="text-[12px] text-danger">muddati o'tgan</div>}
          </div>
        ) : s.status === 'LEAD' || s.status === 'SAMPLE' || s.status === 'INACTIVE' ? (
          <StatusBadge kind="shop" status={s.status} small />
        ) : null
      }
    />
  );
}
