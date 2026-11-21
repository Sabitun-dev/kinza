import { useState } from 'react';
import { Page } from '../../ui/page';
import { Button, Chip, Chips, EmptyState, ErrorBox, List, Money, Row, SearchInput, SkeletonList, StatusBadge, useDebounced } from '../../ui/kit';
import { useApi } from '../../api';
import { useNav } from '../../nav';
import { useRole } from '../../session';
import { addDays, dayLabel, localDate } from '../../util';
import { t } from '@shared/i18n';
import { formatMoney } from '@shared/money';

export interface OrderListItem {
  id: number;
  number: string;
  status: string;
  shop: { id: number; name: string; address: string | null };
  deliveryDate: string;
  total: number;
  packs: number;
  payStatus: string | null;
  outstanding: number;
  agentName: string | null;
  driverName: string | null;
  syncNote: string | null;
}

type F = 'today' | 'tomorrow' | 'draft' | 'open' | 'transit' | 'delivered' | 'unpaid' | 'cancelled' | 'all';

function pathFor(f: F, q: string) {
  const today = localDate();
  const base = `/orders?q=${encodeURIComponent(q)}`;
  switch (f) {
    case 'today':
      return `${base}&date=${today}&status=CONFIRMED,IN_TRANSIT,DELIVERED`;
    case 'tomorrow':
      return `${base}&date=${addDays(today, 1)}&status=CONFIRMED,IN_TRANSIT`;
    case 'draft':
      return `${base}&status=DRAFT`;
    case 'open':
      return `${base}&status=CONFIRMED`;
    case 'transit':
      return `${base}&status=IN_TRANSIT`;
    case 'delivered':
      return `${base}&status=DELIVERED`;
    case 'unpaid':
      return `${base}&unpaid=1`;
    case 'cancelled':
      return `${base}&status=CANCELLED`;
    default:
      return base;
  }
}

export function OrdersTab() {
  const nav = useNav();
  const role = useRole();
  const [f, setF] = useState<F>(role === 'DRIVER' ? 'open' : 'today');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, error, reload } = useApi<{ orders: OrderListItem[] }>(pathFor(f, dq));
  const orders = data?.orders ?? [];
  const sum = orders.reduce((s, o) => s + (f === 'unpaid' ? o.outstanding : o.total), 0);
  const filters: [F, string][] = [
    ['today', 'Bugun'],
    ['tomorrow', 'Ertaga'],
    ['open', 'Tasdiqlangan'],
    ['transit', "Yo'lda"],
    ...(role !== 'DRIVER' ? ([['draft', 'Qoralama']] as [F, string][]) : []),
    ['delivered', 'Yetkazilgan'],
    ...(role !== 'DRIVER' ? ([['unpaid', "To'lanmagan"]] as [F, string][]) : []),
    ['cancelled', 'Bekor'],
    ['all', t('common.all')],
  ];
  return (
    <Page title={role === 'DRIVER' ? 'Yetkazishlar' : t('tabs.orders')} subtitle={data && orders.length ? `${orders.length} ta · ${formatMoney(sum)}` : undefined}>
      <SearchInput value={q} onChange={setQ} placeholder="Raqam yoki do'kon…" />
      <Chips className="mt-3">
        {filters.map(([k, label]) => (
          <Chip key={k} active={f === k} onClick={() => setF(k)}>
            {label}
          </Chip>
        ))}
      </Chips>
      <div className="mt-3">
        {error && <ErrorBox error={error} onRetry={reload} />}
        {!data && !error && <SkeletonList />}
        {data && orders.length === 0 && (
          <EmptyState
            icon="orders"
            title="Buyurtma yo'q"
            action={role !== 'DRIVER' ? <Button icon="plus" onClick={() => nav.push('order-new')}>Yangi buyurtma</Button> : undefined}
          />
        )}
        {orders.length > 0 && (
          <List>
            {orders.map((o) => (
              <OrderRow key={o.id} o={o} onClick={() => nav.push('order', { id: o.id })} />
            ))}
          </List>
        )}
      </div>
    </Page>
  );
}

export function OrderRow({ o, onClick }: { o: OrderListItem; onClick: () => void }) {
  return (
    <Row
      onClick={onClick}
      title={o.shop.name}
      subtitle={`${o.number} · ${o.packs} blok · ${dayLabel(o.deliveryDate)}${o.syncNote ? ' · ⚠️' : ''}`}
      right={
        <div className="flex flex-col items-end gap-1">
          <Money value={o.payStatus === 'PARTIAL' || o.payStatus === 'OVERDUE' ? o.outstanding : o.total} className="font-semibold" />
          {o.payStatus && o.status === 'DELIVERED' ? <StatusBadge kind="pay" status={o.payStatus} small /> : <StatusBadge kind="order" status={o.status} small />}
        </div>
      }
    />
  );
}
