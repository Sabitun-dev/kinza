import { useEffect, useRef, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Card, Chip, Chips, EmptyState, Field, List, Row, Skeleton, SkeletonList, StatusBadge, TextArea, TextInput, cx } from '../../ui/kit';
import { api, ApiError, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { toast } from '../../ui/toast';
import { haptic } from '../../tg';
import { addDays, ago, dayLabel, getPosition, localDate, uid } from '../../util';
import { ShopPicker } from '../orders/ShopPicker';
import { queueRequest } from '../../offline/queue';
import { markShopDone } from '../route/Drive';
import { t } from '@shared/i18n';

const RESULTS = [
  { value: 'ORDERED', icon: '🛒' },
  { value: 'THINKING', icon: '🤔' },
  { value: 'REFUSED', icon: '🙅' },
  { value: 'CLOSED', icon: '🔒' },
] as const;

/** "Tashrif" in 3 taps: shop → result → (note, follow-up date). */
export function VisitNew({ shopId: initial }: { shopId?: number }) {
  const [shopId, setShopId] = useState(initial);
  if (!shopId) return <ShopPicker title="Tashrif" onPick={setShopId} />;
  return <VisitForm shopId={shopId} />;
}

function VisitForm({ shopId }: { shopId: number }) {
  const nav = useNav();
  const shop = useApi<any>(`/shops/${shopId}`);
  const [result, setResult] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [follow, setFollow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(uid());
  const pos = useRef<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    getPosition(6000).then((p) => (pos.current = p));
  }, []);

  useMainButton({
    text: result === 'ORDERED' ? 'Sotishga o‘tish' : 'Saqlash',
    disabled: !result,
    progress: busy,
    onClick: async () => {
      if (result === 'ORDERED') return nav.replace('sell', { shopId });
      setBusy(true);
      const body = { shopId, result, note: note || null, followUpDate: follow, lat: pos.current?.lat ?? null, lng: pos.current?.lng ?? null, idempotencyKey: key.current };
      try {
        await api.post('/visits', body);
        toast('Tashrif saqlandi ✅');
      } catch (e) {
        if ((e as ApiError).code !== 'offline') {
          setBusy(false);
          return toast.error(e);
        }
        await queueRequest('visit', `Tashrif: ${shop.data?.shop.name ?? ''}`, '/visits', body);
        toast("Internet yo'q — saqlandi, keyin yuboriladi");
      }
      markShopDone(shopId);
      haptic.success();
      invalidate('/checklist', '/visits', '/reminders', '/today');
      nav.pop();
    },
  });

  if (!shop.data) return <Page title="Tashrif"><Skeleton className="h-60" /></Page>;
  return (
    <Page title="Tashrif" subtitle={shop.data.shop.name}>
      <div className="grid grid-cols-2 gap-3">
        {RESULTS.map((r) => (
          <button
            key={r.value}
            onClick={() => (haptic.tap(), setResult(r.value))}
            className={cx('flex min-h-[84px] flex-col items-center justify-center gap-1 rounded-[18px] p-3 text-[15px] font-semibold shadow-card', result === r.value ? 'bg-brand text-brand-ink' : 'bg-card')}
          >
            <span className="text-[26px]">{r.icon}</span>
            {t(`visitResult.${r.value}` as never)}
          </button>
        ))}
      </div>
      {result && result !== 'ORDERED' && (
        <div className="mt-4 space-y-4">
          <Field label="Izoh">
            <TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nima dedi?" />
          </Field>
          <Field label="Qayta borish (eslatma)">
            <Chips>
              <Chip active={follow === null} onClick={() => setFollow(null)}>Kerak emas</Chip>
              <Chip active={follow === addDays(localDate(), 3)} onClick={() => setFollow(addDays(localDate(), 3))}>3 kun</Chip>
              <Chip active={follow === addDays(localDate(), 7)} onClick={() => setFollow(addDays(localDate(), 7))}>1 hafta</Chip>
              <Chip active={follow === addDays(localDate(), 14)} onClick={() => setFollow(addDays(localDate(), 14))}>2 hafta</Chip>
            </Chips>
            <TextInput type="date" className="mt-2" value={follow ?? ''} min={localDate()} onChange={(e) => setFollow(e.target.value || null)} />
          </Field>
        </div>
      )}
    </Page>
  );
}

export function VisitsScreen() {
  const nav = useNav();
  const [days, setDays] = useState(7);
  const { data } = useApi<{ visits: any[] }>(`/visits?from=${addDays(localDate(), -(days - 1))}`);
  return (
    <Page title="Tashriflar" subtitle={data ? `${data.visits.length} ta` : undefined}>
      <Chips>
        <Chip active={days === 1} onClick={() => setDays(1)}>Bugun</Chip>
        <Chip active={days === 7} onClick={() => setDays(7)}>7 kun</Chip>
        <Chip active={days === 30} onClick={() => setDays(30)}>30 kun</Chip>
      </Chips>
      <div className="mt-3">
        {!data ? (
          <SkeletonList />
        ) : data.visits.length === 0 ? (
          <EmptyState icon="pin" title="Tashrif yo'q" />
        ) : (
          <List>
            {data.visits.map((v) => (
              <Row
                key={v.id}
                title={v.shop.name}
                subtitle={`${ago(v.at)} · ${v.by}${v.note ? ' · ' + v.note : ''}${v.followUpDate ? ` · qayta: ${dayLabel(String(v.followUpDate).slice(0, 10))}` : ''}`}
                right={<Badge tone={v.result === 'ORDERED' ? 'ok' : v.result === 'CLOSED' ? 'danger' : 'warn'}>{t(`visitResult.${v.result}` as never)}</Badge>}
                onClick={() => nav.push('shop', { id: v.shop.id })}
              />
            ))}
          </List>
        )}
      </div>
    </Page>
  );
}

/** Leads pipeline (Kanban): Lead → Namuna berildi → Buyurtma qildi → Doimiy. */
export function LeadsScreen() {
  const nav = useNav();
  const { data, reload } = useApi<{ columns: { status: string; shops: any[] }[]; conversion: { from: string; to: string; percent: number }[] }>('/leads');
  const move = async (shopId: number, status: string) => {
    try {
      await api.patch(`/shops/${shopId}`, { status });
      haptic.success();
      invalidate('/shops', '/leads');
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  if (!data) return <Page title="Leadlar"><SkeletonList /></Page>;
  const order = data.columns.map((c) => c.status);
  return (
    <Page title="Leadlar">
      <div className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 text-[12.5px] text-muted">
        {data.conversion.map((c) => (
          <span key={c.to} className="shrink-0 rounded-full bg-card px-2.5 py-1 shadow-card">
            {t(`shopStatus.${c.from}` as never)} → {t(`shopStatus.${c.to}` as never)}: <b className="text-text">{c.percent}%</b>
          </span>
        ))}
      </div>
      <div className="no-scrollbar -mx-4 mt-3 flex snap-x gap-3 overflow-x-auto px-4 pb-4">
        {data.columns.map((col, ci) => (
          <div key={col.status} className="w-[78vw] max-w-[320px] shrink-0 snap-start">
            <div className="mb-2 flex items-center justify-between px-1">
              <StatusBadge kind="shop" status={col.status} />
              <span className="text-[13px] font-semibold text-muted">{col.shops.length}</span>
            </div>
            <div className="space-y-2">
              {col.shops.length === 0 && <Card className="text-center text-[14px] text-muted">Bo'sh</Card>}
              {col.shops.map((s) => (
                <Card key={s.id} className="p-3">
                  <button className="block w-full text-left" onClick={() => nav.push('shop', { id: s.id })}>
                    <div className="truncate font-bold">{s.name}</div>
                    <div className="truncate text-[13px] text-muted">{s.address ?? ''}</div>
                  </button>
                  {ci < order.length - 1 && (
                    <button className="mt-2 h-10 w-full rounded-[10px] bg-brand-soft text-[14px] font-semibold text-brand" onClick={() => move(s.id, order[ci + 1])}>
                      → {t(`shopStatus.${order[ci + 1]}` as never)}
                    </button>
                  )}
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}
