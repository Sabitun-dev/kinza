import { useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, Chip, Chips, EmptyState, Field, List, Money, Qty, Row, Section, Skeleton, SkeletonList, Stepper, TextArea, TextInput, cx } from '../../ui/kit';
import { Sheet } from '../../ui/sheet';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { useIsOwner, useSession } from '../../session';
import { toast } from '../../ui/toast';
import { confirmDialog } from '../../tg';
import { ago, addDays, localDate } from '../../util';
import { ShopPicker } from '../orders/ShopPicker';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/dates';
import { splitCans } from '@shared/qty';
import { t } from '@shared/i18n';

// ── Payments list ──
export function PaymentsScreen() {
  const owner = useIsOwner();
  const [range, setRange] = useState<'today' | 'week' | 'month'>('week');
  const from = range === 'today' ? localDate() : range === 'week' ? addDays(localDate(), -6) : localDate().slice(0, 8) + '01';
  const { data } = useApi<{ payments: any[]; total: number }>(`/payments?from=${from}`);
  const [voiding, setVoiding] = useState<any>(null);
  return (
    <Page title="To'lovlar" subtitle={data ? `Jami: ${formatMoney(data.total)}` : undefined}>
      <Chips>
        <Chip active={range === 'today'} onClick={() => setRange('today')}>Bugun</Chip>
        <Chip active={range === 'week'} onClick={() => setRange('week')}>7 kun</Chip>
        <Chip active={range === 'month'} onClick={() => setRange('month')}>Shu oy</Chip>
      </Chips>
      <div className="mt-3">
        {!data ? (
          <SkeletonList />
        ) : data.payments.length === 0 ? (
          <EmptyState icon="wallet" title="To'lov yo'q" />
        ) : (
          <List>
            {data.payments.map((p) => (
              <Row
                key={p.id}
                title={p.shop.name}
                subtitle={`${t(`payMethod.${p.method}` as never)} · ${p.receivedBy} · ${ago(p.paidAt)}${p.orderNumber ? ' · ' + p.orderNumber : ''}`}
                right={
                  <div className="flex flex-col items-end gap-1">
                    <Money value={p.amount} className="font-semibold text-ok" sign />
                    {p.inHands && <Badge tone="warn">qo'lda</Badge>}
                  </div>
                }
                onClick={owner ? () => setVoiding(p) : undefined}
                chevron={false}
              />
            ))}
          </List>
        )}
      </div>
      {voiding && <VoidSheet payment={voiding} onClose={() => setVoiding(null)} />}
    </Page>
  );
}

function VoidSheet({ payment, onClose }: { payment: any; onClose: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <Sheet
      open
      onClose={onClose}
      title={`${payment.shop.name} · ${formatMoney(payment.amount)}`}
      footer={
        <Button
          block
          variant="danger"
          disabled={!reason.trim()}
          onClick={async () => {
            try {
              await api.post(`/payments/${payment.id}/void`, { reason });
              invalidate('/payments', '/shops', '/debtors', '/orders', '/cash');
              toast("To'lov bekor qilindi");
              onClose();
            } catch (e) {
              toast.error(e);
            }
          }}
        >
          To'lovni bekor qilish
        </Button>
      }
    >
      <Field label="Sabab">
        <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Masalan: ikki marta kiritilgan" />
      </Field>
    </Sheet>
  );
}

// ── Cash in hands ──
export function CashScreen() {
  const owner = useIsOwner();
  const { data, reload } = useApi<{ people: any[]; handovers: any[] }>('/cash');
  const [busy, setBusy] = useState<number | null>(null);
  return (
    <Page title="Kassa" subtitle="Agent va haydovchi qo'lidagi pul">
      {!data ? (
        <SkeletonList rows={3} />
      ) : data.people.length === 0 ? (
        <EmptyState icon="cash" title="Hamma pul topshirilgan ✅" />
      ) : (
        <div className="space-y-3">
          {data.people.map((p) => (
            <Card key={p.userId}>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-[17px] font-bold">{p.name}</div>
                  <div className="text-[13px] text-muted">{p.payments.length} ta to'lov · {Object.entries(p.byMethod).map(([m, v]) => `${t(`payMethod.${m}` as never)}: ${formatMoney(v as number)}`).join(' · ')}</div>
                </div>
                <Money value={p.total} className="text-[19px] font-bold" />
              </div>
              <div className="mt-2 max-h-40 overflow-y-auto text-[14px]">
                {p.payments.map((x: any) => (
                  <div key={x.id} className="flex justify-between border-t border-line py-1.5">
                    <span className="truncate">{x.shopName} <span className="text-muted">· {ago(x.paidAt)}</span></span>
                    <span className="num">{formatMoney(x.amount)}</span>
                  </div>
                ))}
              </div>
              {owner && (
                <Button
                  block
                  className="mt-3"
                  icon="check"
                  loading={busy === p.userId}
                  onClick={async () => {
                    if (!(await confirmDialog(`${p.name}dan ${formatMoney(p.total)} oldingizmi?`))) return;
                    setBusy(p.userId);
                    try {
                      await api.post('/cash/handover', { userId: p.userId });
                      toast('Topshirildi ✅');
                      reload();
                    } catch (e) {
                      toast.error(e);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  Topshirildi
                </Button>
              )}
            </Card>
          ))}
        </div>
      )}
      {data && data.handovers.length > 0 && (
        <Section title="Topshirilganlar">
          <List>
            {data.handovers.map((h) => (
              <Row key={h.id} title={formatMoney(h.amount)} subtitle={`${h.from} → ${h.confirmedBy} · ${ago(h.at)}`} />
            ))}
          </List>
        </Section>
      )}
    </Page>
  );
}

// ── Returns ──
export function ReturnsScreen() {
  const nav = useNav();
  const { data } = useApi<{ returns: any[] }>('/returns');
  return (
    <Page title="Qaytarishlar" right={<Button size="sm" icon="plus" onClick={() => nav.push('return-new')}>Yangi</Button>}>
      {!data ? (
        <SkeletonList />
      ) : data.returns.length === 0 ? (
        <EmptyState icon="return" title="Qaytarish yo'q" />
      ) : (
        <List>
          {data.returns.map((r) => (
            <Row
              key={r.id}
              title={r.shop.name}
              subtitle={`${r.number} · ${ago(r.date)} · ${r.items.map((i: any) => i.flavour).join(', ')}`}
              right={<Money value={r.total} className="font-semibold" />}
              onClick={() => nav.push('shop', { id: r.shop.id })}
            />
          ))}
        </List>
      )}
    </Page>
  );
}

export function ReturnNew({ shopId: initial, orderId }: { shopId?: number; orderId?: number }) {
  const [shopId, setShopId] = useState(initial);
  if (!shopId) return <ShopPicker title="Qaytarish" onPick={setShopId} />;
  return <ReturnForm shopId={shopId} orderId={orderId} />;
}

function ReturnForm({ shopId, orderId }: { shopId: number; orderId?: number }) {
  const nav = useNav();
  const order = useApi<{ order: any }>(orderId ? `/orders/${orderId}` : null);
  const form = useApi<any>(`/order-form?shopId=${shopId}`);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [cond, setCond] = useState<Record<number, 'SELLABLE' | 'DAMAGED' | 'EXPIRED'>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const products: any[] = orderId
    ? (order.data?.order.items ?? []).filter((i: any) => !i.isBonus).map((i: any) => ({ id: i.productId, flavour: i.flavour, packSize: i.packSize, perCan: i.pricePerCan, max: i.qtyCans }))
    : (form.data?.products ?? []).map((p: any) => ({ id: p.id, flavour: p.flavour, packSize: p.packSize, perCan: p.perCan, max: 99999 }));
  const lines = products.filter((p) => (qty[p.id] ?? 0) > 0);
  const total = lines.reduce((s, p) => s + (qty[p.id] ?? 0) * (p.perCan ?? 0), 0);

  useMainButton({
    text: total ? `Qaytarishni saqlash · ${formatMoney(total)}` : 'Qaytarishni saqlash',
    disabled: !lines.length,
    progress: busy,
    onClick: async () => {
      setBusy(true);
      try {
        const r = await api.post('/returns', {
          shopId,
          orderId: orderId ?? null,
          reason: reason || null,
          lines: lines.map((p) => ({ productId: p.id, qtyCans: qty[p.id], condition: cond[p.id] ?? 'DAMAGED' })),
        });
        invalidate('/returns', '/shops', '/orders', '/products', '/debtors');
        toast(`Qaytarish ${r.number} ✅ Qarz: ${formatMoney(Math.max(0, r.balance))}`);
        nav.pop();
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });

  if ((orderId && !order.data) || (!orderId && !form.data)) return <Page title="Qaytarish"><Skeleton className="h-80" /></Page>;
  return (
    <Page title="Qaytarish" subtitle={orderId ? order.data?.order.number : form.data?.shop.name}>
      <div className="space-y-3">
        {products.map((p) => {
          const q = qty[p.id] ?? 0;
          const { packs, cans } = splitCans(q, p.packSize);
          return (
            <Card key={p.id} className={cx(q > 0 && 'ring-2 ring-warn')}>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="font-bold">{p.flavour}</div>
                  <div className="text-[13px] text-muted">{p.perCan != null ? `${formatMoney(p.perCan)} / dona` : ''}</div>
                </div>
                <div className="flex gap-2">
                  <Stepper size="md" value={packs} label="blok" onChange={(v) => setQty((x) => ({ ...x, [p.id]: Math.min(p.max, v * p.packSize + cans) }))} />
                  <Stepper size="md" value={cans} max={p.packSize - 1} label="dona" onChange={(v) => setQty((x) => ({ ...x, [p.id]: Math.min(p.max, packs * p.packSize + v) }))} />
                </div>
              </div>
              {q > 0 && (
                <Chips className="mt-2">
                  {(['DAMAGED', 'EXPIRED', 'SELLABLE'] as const).map((c) => (
                    <Chip key={c} active={(cond[p.id] ?? 'DAMAGED') === c} onClick={() => setCond((x) => ({ ...x, [p.id]: c }))}>
                      {t(`returnCondition.${c}` as never)}
                    </Chip>
                  ))}
                </Chips>
              )}
            </Card>
          );
        })}
      </div>
      <Section title="Sabab">
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Masalan: ezilgan bankalar" />
      </Section>
      <div className="mt-3 text-[13px] text-muted">Sotsa bo'ladigan bankalar omborga qaytadi. Shikastlanganlari alohida hisobda turadi.</div>
    </Page>
  );
}

// ── Akt sverki ──
export function ReconciliationScreen({ shopId }: { shopId: number }) {
  const today = localDate();
  const monthStart = today.slice(0, 8) + '01';
  const prevMonthEnd = addDays(monthStart, -1);
  const prevMonthStart = prevMonthEnd.slice(0, 8) + '01';
  const yearStart = today.slice(0, 5) + '01-01';
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const { data } = useApi<any>(`/shops/${shopId}/reconciliation?from=${from}&to=${to}`);
  const shop = useApi<any>(`/shops/${shopId}`);
  const [busy, setBusy] = useState(false);
  const { settings } = useSession();
  useMainButton({
    text: 'PDF yaratish va chatga yuborish',
    progress: busy,
    onClick: async () => {
      setBusy(true);
      try {
        await api.post(`/shops/${shopId}/reconciliation`, { from, to });
        invalidate(`/shops/${shopId}`);
        toast(t('common.sentToChat'));
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });
  const set = (f: string, tt: string) => (setFrom(f), setTo(tt));
  return (
    <Page title="Akt sverki" subtitle={shop.data?.shop.name}>
      <Chips>
        <Chip active={from === monthStart && to === today} onClick={() => set(monthStart, today)}>Shu oy</Chip>
        <Chip active={from === prevMonthStart && to === prevMonthEnd} onClick={() => set(prevMonthStart, prevMonthEnd)}>O'tgan oy</Chip>
        <Chip active={from === yearStart && to === today} onClick={() => set(yearStart, today)}>Shu yil</Chip>
      </Chips>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Dan">
          <TextInput type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Gacha">
          <TextInput type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {!data ? (
        <Skeleton className="mt-4 h-60" />
      ) : (
        <Card className="mt-4" padded={false}>
          <RRow label={`${formatDate(from)} holatiga qoldiq`} value={data.opening} bold />
          {data.rows.map((r: any, i: number) => (
            <RRow key={i} label={`${formatDate(r.date)} · ${r.doc}`} value={r.debit || -r.credit} sign />
          ))}
          <RRow label={`${formatDate(to)} holatiga qoldiq`} value={data.closing} bold />
        </Card>
      )}
      <div className="mt-3 text-[13px] text-muted">+ yetkazildi (debet), − to'landi yoki qaytdi (kredit). Hujjatda {settings.businessName} rekvizitlari chiqadi.</div>
    </Page>
  );
}

function RRow({ label, value, bold, sign }: { label: string; value: number; bold?: boolean; sign?: boolean }) {
  return (
    <div className={cx('flex items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-0', bold && 'bg-card2 font-bold')}>
      <span className="text-[14.5px]">{label}</span>
      <span className={cx('num whitespace-nowrap', sign && value < 0 && 'text-ok')}>
        {sign && value > 0 ? '+' : ''}
        {formatMoney(value)}
      </span>
    </div>
  );
}


