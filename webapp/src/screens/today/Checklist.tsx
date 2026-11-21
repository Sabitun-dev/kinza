import { lazy, Suspense, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, Chip, Chips, EmptyState, ErrorBox, Segmented, Skeleton, Spinner, TextInput, cx } from '../../ui/kit';
import { Sheet } from '../../ui/sheet';
import { Icon } from '../../ui/icons';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { useSession } from '../../session';
import { toast } from '../../ui/toast';
import { haptic } from '../../tg';
import { ago, addDays, dayLabel, getPosition, localDate } from '../../util';
import { formatDateHuman, WEEKDAYS_UZ, weekday } from '@shared/dates';
import { formatMoney } from '@shared/money';

import { TodayTab } from './TodayTab';

const ChecklistMap = lazy(() => import('../../map/ChecklistMap'));

export const STATUS_META: Record<string, { icon: string; label: string; tone: string }> = {
  PENDING: { icon: '⏳', label: 'Kutilmoqda', tone: 'bg-grey-soft text-muted' },
  SOLD: { icon: '✅', label: 'Sotildi', tone: 'bg-ok-soft text-ok' },
  DELIVERED: { icon: '📦', label: 'Yetkazildi', tone: 'bg-ok-soft text-ok' },
  NO_ORDER: { icon: '🚫', label: "Buyurtma yo'q", tone: 'bg-warn-soft text-warn' },
  CLOSED: { icon: '🔒', label: 'Yopiq edi', tone: 'bg-danger-soft text-danger' },
  MOVED: { icon: '↪️', label: "Ko'chirildi", tone: 'bg-info-soft text-info' },
};

export interface ChecklistRow {
  id: number;
  shopId: number;
  status: string;
  source: string;
  reason: string | null;
  carryCount: number;
  movedTo: string | null;
  position: number | null;
  etaMin: number | null;
  legKm: number | null;
  orderId: number | null;
  order: { id: number; total: number; status: string } | null;
  shop: { id: number; name: string; address: string | null; phones: string[]; lat: number | null; lng: number | null; notes: string | null; area: string | null; openFrom: string | null; openTo: string | null };
  balance: number;
  overdue: number;
  lastOrderAt: string | null;
}

type Filter = 'all' | 'left' | 'done';

/** "Bugun": today's shop checklist. Nothing gets forgotten. Drivers keep their delivery overview. */
export function ChecklistHome() {
  const { user } = useSession();
  return user.role === 'DRIVER' ? <TodayTab /> : <ChecklistScreen />;
}

function ChecklistScreen() {
  const nav = useNav();
  const { user } = useSession();
  const { data, error, reload } = useApi<any>('/checklist');
  const extra = useApi<any>(user.role === 'OWNER' ? '/today' : null);
  const [filter, setFilter] = useState<Filter>('left');
  const [view, setView] = useState<'list' | 'map'>('list');
  const [actionFor, setActionFor] = useState<ChecklistRow | null>(null);
  const today = localDate();

  const items: ChecklistRow[] = data?.items ?? [];
  const shown = items.filter((i) => (filter === 'all' ? true : filter === 'left' ? i.status === 'PENDING' : i.status !== 'PENDING'));
  const pending = items.filter((i) => i.status === 'PENDING').length;

  useMainButton({
    text: pending ? "🚗 Yo'lga chiqish" : '🏁 Kun yakuni',
    visible: !!data && !data.dayOff && !data.closed && items.length > 0,
    onClick: () => nav.push(pending ? 'drive' : 'day-close', { checklistId: data.id }),
  });

  return (
    <Page title={`Salom, ${user.name.split(' ')[0]}!`} subtitle={`${WEEKDAYS_UZ[weekday(today)]}, ${formatDateHuman(today)}`}>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && (
        <div className="space-y-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-64" />
        </div>
      )}
      {data?.problems?.length > 0 && (
        <Card className="mb-3 border-2 border-danger bg-danger-soft shadow-none">
          <div className="font-bold text-danger">⚠️ {data.problems.length} ta do'kon rejaga kirmaydi</div>
          <div className="mt-1 space-y-1">
            {data.problems.slice(0, 6).map((p: any) => (
              <button key={p.id} className="flex w-full items-center justify-between py-1 text-left text-[14.5px]" onClick={() => nav.push('shop-edit', { id: p.id })}>
                <span className="font-semibold">{p.name}</span>
                <span className="text-danger">{p.missing.join(', ')} yo'q ›</span>
              </button>
            ))}
          </div>
        </Card>
      )}
      {data?.dayOff && (
        <EmptyState icon="calendar" title="Bugun dam olish kuni 🌿" text={`Keyingi ish kuni: ${dayLabel(data.nextWorkingDay)}. Bugungi do'konlar o'sha kunga o'tadi.`} />
      )}
      {data && !data.dayOff && data.items && (
        <>
          {/* Header */}
          <Card className="bg-brand text-brand-ink">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold opacity-80">{data.areas.length ? `${data.areas.join(', ')} hudud` : 'Bugungi ro‘yxat'}</div>
                <div className="num text-[26px] leading-tight font-bold">
                  {data.done} / {data.total} do'kon
                </div>
              </div>
              {data.closed && <span className="rounded-full bg-white/20 px-3 py-1 text-[13px] font-semibold">Kun yopildi ✓</span>}
            </div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${data.total ? (data.done / data.total) * 100 : 0}%` }} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[13px]">
              <div>
                <div className="opacity-70">Yig'ildi / yig'iladi</div>
                <div className="num font-semibold">
                  <span className="text-accent">{formatMoney(data.collected).replace(" so'm", '')}</span> / {formatMoney(data.toCollect)}
                </div>
              </div>
              <div>
                <div className="opacity-70">Km: yurildi / reja</div>
                <div className="num font-semibold">
                  {data.drivenKm != null ? Math.round(data.drivenKm) : '—'} / {data.plannedKm != null ? Math.round(data.plannedKm) : '—'}
                </div>
              </div>
            </div>
          </Card>

          {extra.data?.tashkent && extra.data.tashkent.packs > 0 && !extra.data.tashkent.orderedToday && weekday(today) === 4 && (
            <Card className="mt-3 border-2 border-accent" onClick={() => nav.push('supplier-proposal')}>
              <div className="font-bold">📦 Toshkentga buyurtma: {extra.data.tashkent.packs} blok</div>
              <div className="text-[13px] text-muted">Bugun {extra.data.tashkent.cutoff} gacha</div>
            </Card>
          )}

          <div className="mt-3 flex items-center gap-2">
            <Chips className="flex-1">
              <Chip active={filter === 'left'} onClick={() => setFilter('left')}>Qolganlar {pending}</Chip>
              <Chip active={filter === 'done'} onClick={() => setFilter('done')}>Bajarilganlar {data.done}</Chip>
              <Chip active={filter === 'all'} onClick={() => setFilter('all')}>Hammasi</Chip>
            </Chips>
            <div className="w-[118px] shrink-0">
              <Segmented value={view} onChange={setView} options={[{ value: 'list', label: '☰' }, { value: 'map', label: '🗺' }]} />
            </div>
          </div>

          {items.length === 0 && <EmptyState icon="check" title="Bugun rejada do'kon yo'q" text="Hududlarga hafta kuni va do'konlarga hudud belgilang." action={<Button onClick={() => nav.push('districts')}>Hududlar</Button>} />}

          {view === 'map' && items.length > 0 && (
            <div className="mt-3">
              <Suspense fallback={<div className="flex h-[55vh] items-center justify-center"><Spinner /></div>}>
                <ChecklistMap items={items} route={data.route} onOpen={(r) => setActionFor(r)} />
              </Suspense>
            </div>
          )}

          {view === 'list' && (
            <div className="mt-3 space-y-2">
              {shown.length === 0 && items.length > 0 && <Card className="text-center text-muted">{filter === 'left' ? "Hammasi bajarildi ✅ Kun yakunini qiling." : "Hali hech narsa bajarilmagan"}</Card>}
              {shown.map((r) => (
                <ChecklistRowCard key={r.id} r={r} n={items.indexOf(r) + 1} onOpen={() => (r.status === 'PENDING' ? nav.push('sell', { shopId: r.shopId, orderId: r.orderId ?? undefined }) : nav.push('shop', { id: r.shopId }))} onMore={() => setActionFor(r)} />
              ))}
            </div>
          )}

          {!data.closed && items.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button variant="soft" size="md" icon="route" className="col-span-2" onClick={() => nav.push('route')}>
                {data.route ? `Marshrut: ${data.route.totalKm} km · tejaldi ${data.route.savedKm} km` : 'Marshrutni ko‘rish'}
              </Button>
              <Button variant="secondary" size="md" icon="file" onClick={async () => { await api.post(`/checklist/${data.id}/print`); toast("Ro'yxat chatingizda ✅"); }}>
                PDF ro'yxat
              </Button>
              <Button variant="secondary" size="md" icon="check" onClick={() => nav.push('day-close', { checklistId: data.id })}>
                Kun yakuni
              </Button>
            </div>
          )}

          {extra.data?.reminders?.length > 0 && (
            <Card className="mt-4" onClick={() => nav.push('reminders')}>
              🔔 Eslatmalar: <b>{extra.data.reminders.length}</b> — {extra.data.reminders.map((r: any) => r.note).slice(0, 2).join(', ')}
            </Card>
          )}
          {extra.data?.stock?.low?.length > 0 && (
            <Card className="mt-3" onClick={() => nav.setTab('stock')}>
              📦 Kam qoldi: {extra.data.stock.low.map((s: any) => s.flavour).slice(0, 5).join(', ')}
            </Card>
          )}
        </>
      )}
      {actionFor && <RowActions r={actionFor} onClose={() => setActionFor(null)} onDone={() => (setActionFor(null), invalidate('/checklist', '/today'))} />}
    </Page>
  );
}

export function ChecklistRowCard({ r, n, onOpen, onMore }: { r: ChecklistRow; n: number; onOpen: () => void; onMore: () => void }) {
  const meta = STATUS_META[r.status];
  const pending = r.status === 'PENDING';
  return (
    <Card padded={false} className={cx('flex items-stretch overflow-hidden', !pending && 'opacity-75')}>
      <button className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left active:bg-card2" onClick={() => (haptic.tap(), onOpen())}>
        <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-bold', pending ? 'bg-brand text-brand-ink' : 'bg-card2')}>{pending ? n : meta.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[16.5px] font-bold">{r.shop.name}</span>
            {r.source === 'CARRY' && <Badge tone="danger">Kecha qolgan{r.carryCount > 1 ? ` ×${r.carryCount}` : ''}</Badge>}
            {r.source === 'NEW' && <Badge tone="info">Yangi</Badge>}
            {r.source === 'PREORDER' && <Badge tone="accent">📦 Buyurtma</Badge>}
            {r.source === 'MOVED' && <Badge tone="info">Ko'chirilgan</Badge>}
          </span>
          <span className="block truncate text-[13.5px] text-muted">{r.shop.address ?? r.shop.area ?? ''}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {r.balance > 0 && <Badge tone={r.overdue > 0 ? 'danger' : 'warn'}>Qarz {formatMoney(r.balance)}</Badge>}
            <Badge>{r.lastOrderAt ? `oxirgi: ${ago(r.lastOrderAt)}` : 'hali olmagan'}</Badge>
            {!pending && (
              <span className={cx('rounded-full px-2 py-0.5 text-[12px] font-semibold', meta.tone)}>
                {meta.icon} {meta.label}
                {r.status === 'MOVED' && r.movedTo ? ` → ${dayLabel(r.movedTo)}` : ''}
              </span>
            )}
          </span>
        </span>
      </button>
      {pending && (
        <button aria-label="Amallar" className="flex w-12 shrink-0 items-center justify-center border-l border-line text-muted" onClick={() => (haptic.tap(), onMore())}>
          <Icon name="more" />
        </button>
      )}
    </Card>
  );
}

const NO_ORDER_REASONS = ["Javon to'la", "Pul yo'q", "Egasi yo'q", 'Boshqa'];

/** Quick actions on a checklist row: Buyurtma yo'q · Yopiq edi · Boshqa kunga. */
export function RowActions({ r, onClose, onDone }: { r: ChecklistRow; onClose: () => void; onDone: () => void }) {
  const nav = useNav();
  const [mode, setMode] = useState<'' | 'noorder' | 'move'>('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(addDays(localDate(), 1));
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const pos = async () => (await getPosition(4000)) ?? null;
  return (
    <Sheet open onClose={onClose} title={r.shop.name}>
      {mode === '' && (
        <div className="space-y-2">
          <Button block icon="cash" onClick={() => (onClose(), nav.push('sell', { shopId: r.shopId, orderId: r.orderId ?? undefined }))}>
            {r.orderId ? 'Yetkazish' : 'Sotish'}
          </Button>
          <Button block variant="secondary" onClick={() => setMode('noorder')}>🚫 Buyurtma yo'q</Button>
          <Button block variant="secondary" loading={busy} onClick={() => run(async () => api.post(`/checklist/items/${r.id}/closed`, { pos: await pos() }), 'Belgilandi: yopiq edi')}>
            🔒 Yopiq edi
          </Button>
          <Button block variant="secondary" onClick={() => setMode('move')}>↪️ Boshqa kunga</Button>
          <Button block variant="ghost" onClick={() => (onClose(), nav.push('shop', { id: r.shopId }))}>Do'kon sahifasi</Button>
        </div>
      )}
      {mode === 'noorder' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {NO_ORDER_REASONS.map((x) => (
              <Chip key={x} active={reason === x} onClick={() => setReason(x)}>
                {x}
              </Chip>
            ))}
          </div>
          {reason === 'Boshqa' && <TextInput autoFocus placeholder="Sabab" onChange={(e) => setReason(e.target.value || 'Boshqa')} />}
          <Button block disabled={!reason} loading={busy} onClick={() => run(async () => api.post(`/checklist/items/${r.id}/no-order`, { reason, pos: await pos() }), "Belgilandi: buyurtma yo'q")}>
            Saqlash
          </Button>
        </div>
      )}
      {mode === 'move' && (
        <div className="space-y-3">
          <Chips>
            <Chip active={date === addDays(localDate(), 1)} onClick={() => setDate(addDays(localDate(), 1))}>Ertaga</Chip>
            <Chip active={date === nextFriday()} onClick={() => setDate(nextFriday())}>Juma</Chip>
            <Chip active={date === addDays(localDate(), 7)} onClick={() => setDate(addDays(localDate(), 7))}>Keyingi hafta</Chip>
          </Chips>
          <TextInput type="date" value={date} min={addDays(localDate(), 1)} onChange={(e) => setDate(e.target.value)} />
          <TextInput placeholder="Sabab (majburiy)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button block disabled={!reason.trim()} loading={busy} onClick={() => run(() => api.post(`/checklist/items/${r.id}/move`, { date, reason }), `Ko'chirildi → ${dayLabel(date)}`)}>
            Ko'chirish
          </Button>
        </div>
      )}
    </Sheet>
  );
}

export function nextFriday() {
  let d = addDays(localDate(), 1);
  while (weekday(d) !== 5) d = addDays(d, 1);
  return d;
}
