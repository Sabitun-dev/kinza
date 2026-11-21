import { useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, ErrorBox, IconButton, List, Money, Qty, Row, Section, Skeleton, StatusBadge, TextArea, cx } from '../../ui/kit';
import { Sheet, ChoiceSheet } from '../../ui/sheet';
import { Icon } from '../../ui/icons';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { useRole } from '../../session';
import { toast } from '../../ui/toast';
import { confirmDialog } from '../../tg';
import { ago, callPhone, dayLabel, formatDate, navigateTo } from '../../util';
import { DocumentList } from './DocumentList';
import { ProductPhoto } from '../stock/StockTab';
import { t } from '@shared/i18n';
import { formatMoney } from '@shared/money';

const ACTION_LABEL: Record<string, string> = {
  'order.create': 'Yaratildi',
  'order.update': "O'zgartirildi",
  'order.confirm': 'Tasdiqlandi',
  'order.ship': "Yo'lga chiqdi",
  'order.deliver': 'Yetkazildi',
  'order.cancel': 'Bekor qilindi',
  'order.revise': 'Tuzatildi',
  'order.assignDriver': 'Haydovchi biriktirildi',
};

export function OrderDetail({ id }: { id: number }) {
  const nav = useNav();
  const role = useRole();
  const owner = role === 'OWNER';
  const { data, error, reload } = useApi<{ order: any }>(`/orders/${id}`);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [driverOpen, setDriverOpen] = useState(false);
  const drivers = useApi<{ users: any[] }>(owner ? '/users' : null);
  const o = data?.order;

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      invalidate('/orders', '/shops', '/products', '/today');
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const main = (() => {
    if (!o) return null;
    if (o.status === 'DRAFT' && role !== 'DRIVER')
      return {
        text: 'Tasdiqlash',
        onClick: () =>
          act(async () => {
            try {
              await api.post(`/orders/${id}/confirm`, {});
            } catch (e: any) {
              if (e.code === 'credit_warning' && owner && (await confirmDialog(`${e.message}\n\nBaribir tasdiqlaysizmi?`))) {
                await api.post(`/orders/${id}/confirm`, { force: true });
              } else throw e;
            }
          }, 'Buyurtma tayyor ✅'),
      };
    if ((o.status === 'CONFIRMED' || o.status === 'IN_TRANSIT') && role !== 'AGENT') return { text: 'Yetkazildi', onClick: () => nav.push('deliver', { id }) };
    if (o.status === 'DELIVERED' && o.outstanding > 0) return { text: `To'lov kiritish · ${formatMoney(o.outstanding)}`, onClick: () => nav.push('payment-new', { shopId: o.shop.id, orderId: id }) };
    return null;
  })();

  useMainButton({ text: main?.text ?? '', visible: !!main, progress: busy, onClick: () => main?.onClick() });

  if (error) return <Page title="Buyurtma"><ErrorBox error={error} onRetry={reload} /></Page>;
  if (!o) {
    return (
      <Page title="Buyurtma">
        <Skeleton className="h-32" />
        <Skeleton className="mt-3 h-72" />
      </Page>
    );
  }

  const editable = ['DRAFT', 'CONFIRMED', 'IN_TRANSIT'].includes(o.status) && role !== 'DRIVER';
  return (
    <Page
      title={o.number}
      subtitle={`${t(`orderStatus.${o.status}` as never)} · yetkazish ${dayLabel(o.deliveryDate)}`}
      right={editable ? <IconButton icon="edit" label="Tahrirlash" onClick={() => nav.push('order-edit', { orderId: id, mode: 'edit' })} /> : undefined}
    >
      <div className="flex flex-wrap gap-2">
        <StatusBadge kind="order" status={o.status} />
        {o.payStatus && <StatusBadge kind="pay" status={o.payStatus} />}
        {o.revision > 0 && <Badge tone="warn">tuzatish {o.revision}</Badge>}
      </div>
      {o.syncNote && <Card className="mt-3 bg-warn-soft text-[14px] font-semibold text-warn shadow-none">⚠️ {o.syncNote}</Card>}
      {o.cancelReason && <Card className="mt-3 bg-danger-soft text-[14px] text-danger shadow-none">Sabab: {o.cancelReason}</Card>}

      <Card className="mt-3" onClick={role !== 'DRIVER' ? () => nav.push('shop', { id: o.shop.id }) : undefined}>
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[18px] font-bold">{o.shop.name}</div>
            <div className="truncate text-[14px] text-muted">{o.shop.address ?? '—'}</div>
            {o.shop.balance > 0 && role !== 'DRIVER' && <div className="text-[14px] font-semibold text-danger">Jami qarz: {formatMoney(o.shop.balance)}</div>}
          </div>
          {o.shop.phones[0] && <IconButton icon="phone" label="Qo'ng'iroq" tone="brand" onClick={() => callPhone(o.shop.phones[0])} />}
          {o.shop.lat && <IconButton icon="nav" label="Yo'nalish" tone="brand" onClick={() => navigateTo(o.shop.lat, o.shop.lng)} />}
        </div>
      </Card>

      <Section title="Mahsulotlar">
        <List>
          {o.items.map((i: any) => (
            <Row
              key={i.id}
              left={<ProductPhoto p={i} className="h-11 w-11 rounded-[10px]" />}
              title={
                <span>
                  {i.flavour} {i.isBonus && <Badge tone="ok">bonus</Badge>}
                </span>
              }
              subtitle={
                <span>
                  <Qty cans={i.qtyCans} packSize={i.packSize} />
                  {i.qtyCans !== i.orderedCans && <span className="text-warn"> (buyurtma: <Qty cans={i.orderedCans} packSize={i.packSize} />)</span>}
                  {i.pricePerPack != null && !i.isBonus && ` × ${formatMoney(i.pricePerPack)}`}
                </span>
              }
              right={i.lineTotal != null ? <Money value={i.lineTotal} className="font-semibold" /> : undefined}
            />
          ))}
        </List>
      </Section>

      <Card className="mt-3">
        {o.subtotal != null && <Line label="Jami" value={o.subtotal} />}
        {o.discount > 0 && <Line label="Chegirma" value={-o.discount} />}
        <Line label="To'lov uchun" value={o.total} bold />
        {o.status === 'DELIVERED' && (
          <>
            {o.paidAmount > 0 && <Line label="To'langan" value={o.paidAmount} tone="ok" />}
            {o.returnedAmount > 0 && <Line label="Qaytarilgan" value={o.returnedAmount} />}
            <Line label="Qoldiq" value={o.outstanding} bold tone={o.outstanding > 0 ? 'danger' : 'ok'} />
            {o.dueDate && <div className="mt-1 text-[13px] text-muted">To'lov muddati: {formatDate(o.dueDate)}</div>}
          </>
        )}
        {owner && o.grossProfit != null && (
          <div className="mt-2 border-t border-line pt-2">
            <Line label="Tannarx" value={o.costTotal} />
            <Line label="Yalpi foyda" value={o.grossProfit} tone="ok" bold />
          </div>
        )}
      </Card>

      {o.comment && <Card className="mt-3 text-[15px]">💬 {o.comment}</Card>}

      {o.payments.length > 0 && (
        <Section title="To'lovlar">
          <List>
            {o.payments.map((p: any, k: number) => (
              <Row
                key={k}
                title={<Money value={p.amount} className="text-ok" sign />}
                subtitle={p.kind === 'payment' ? `${t(`payMethod.${p.method}` as never)} · ${p.by} · ${ago(p.at)}` : `Qaytarish ${p.number}`}
              />
            ))}
          </List>
        </Section>
      )}

      {o.documents.length > 0 && (
        <Section title="Hujjatlar">
          <DocumentList docs={o.documents} />
        </Section>
      )}

      {o.deliveryPhotoUrl && (
        <Section title="Imzolangan yuk xati">
          <img src={o.deliveryPhotoUrl} alt="" className="w-full rounded-[18px]" />
        </Section>
      )}

      <Section title="Amallar">
        <div className="grid grid-cols-2 gap-2">
          {o.status === 'CONFIRMED' && role !== 'AGENT' && (
            <Button size="md" variant="soft" icon="truck" loading={busy} onClick={() => act(() => api.post(`/orders/${id}/ship`, {}), "Yo'lga chiqdi 🚚")}>
              Yo'lga chiqdi
            </Button>
          )}
          {owner && ['DRAFT', 'CONFIRMED', 'IN_TRANSIT'].includes(o.status) && (
            <Button size="md" variant="secondary" icon="user" onClick={() => setDriverOpen(true)}>
              {o.driver ? o.driver.name : 'Haydovchi'}
            </Button>
          )}
          {owner && o.status === 'DELIVERED' && (
            <Button size="md" variant="secondary" icon="edit" onClick={() => nav.push('order-edit', { orderId: id, mode: 'revise' })}>
              Tuzatish
            </Button>
          )}
          {o.status === 'DELIVERED' && role !== 'DRIVER' && (
            <Button size="md" variant="secondary" icon="return" onClick={() => nav.push('return-new', { shopId: o.shop.id, orderId: id })}>
              Qaytarish
            </Button>
          )}
          {role !== 'DRIVER' && o.status !== 'CANCELLED' && (
            <Button size="md" variant="secondary" icon="repeat" onClick={() => nav.push('order-new', { shopId: o.shop.id })}>
              Yana buyurtma
            </Button>
          )}
          {['DRAFT', 'CONFIRMED', 'IN_TRANSIT'].includes(o.status) && role !== 'DRIVER' && (owner || o.status !== 'IN_TRANSIT') && (
            <Button size="md" variant="danger" icon="x" onClick={() => setCancelOpen(true)}>
              Bekor qilish
            </Button>
          )}
        </div>
      </Section>

      <Section title="Tarix">
        <Card>
          <ol className="space-y-2">
            {o.history.map((h: any, k: number) => (
              <li key={k} className="flex gap-3 text-[14px]">
                <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', k === o.history.length - 1 ? 'bg-brand' : 'bg-line')} />
                <span className="flex-1">
                  <b>{ACTION_LABEL[h.action] ?? h.action}</b>
                  {h.by && <span className="text-muted"> · {h.by}</span>}
                </span>
                <span className="text-muted">{ago(h.at)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </Section>

      <CancelSheet open={cancelOpen} onClose={() => setCancelOpen(false)} onCancel={(reason) => act(() => api.post(`/orders/${id}/cancel`, { reason }), 'Bekor qilindi')} />
      <ChoiceSheet
        open={driverOpen}
        onClose={() => setDriverOpen(false)}
        title="Haydovchi"
        value={o.driver?.id ?? 0}
        options={[{ value: 0, label: "O'zim (haydovchisiz)" }, ...(drivers.data?.users ?? []).filter((u) => u.role === 'DRIVER' && u.active).map((u) => ({ value: u.id, label: u.name }))]}
        onPick={(v) => act(() => api.post(`/orders/${id}/driver`, { driverId: v || null }), 'Saqlandi ✅')}
      />
    </Page>
  );
}

function Line({ label, value, bold, tone }: { label: string; value: number; bold?: boolean; tone?: 'ok' | 'danger' }) {
  return (
    <div className={cx('flex justify-between py-0.5', bold && 'text-[18px] font-bold')}>
      <span className={bold ? '' : 'text-muted'}>{label}</span>
      <span className={cx('num', tone === 'ok' && 'text-ok', tone === 'danger' && 'text-danger')}>{formatMoney(value)}</span>
    </div>
  );
}

function CancelSheet({ open, onClose, onCancel }: { open: boolean; onClose: () => void; onCancel: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const quick = ["Do'kon bekor qildi", 'Xato kiritilgan', "Do'kon yopiq", 'Tovar yetmadi'];
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Bekor qilish sababi"
      footer={
        <Button block variant="danger" disabled={!reason.trim()} onClick={() => (onClose(), onCancel(reason.trim()))}>
          Bekor qilish
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {quick.map((q) => (
          <button key={q} className="h-10 rounded-full border border-line bg-card px-3 text-[14px]" onClick={() => setReason(q)}>
            {q}
          </button>
        ))}
      </div>
      <TextArea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Sabab…" />
      <div className="mt-2 flex items-center gap-2 text-[13px] text-muted">
        <Icon name="alert" size={16} /> Band qilingan tovar omborga qaytadi.
      </div>
    </Sheet>
  );
}
