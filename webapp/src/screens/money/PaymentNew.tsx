import { useRef, useState } from 'react';
import { Page } from '../../ui/page';
import { Card, Chip, Chips, Field, MoneyInput, Section, Segmented, Skeleton, TextInput, cx } from '../../ui/kit';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { toast } from '../../ui/toast';
import { openLink } from '../../tg';
import { dayLabel, localDate, uid } from '../../util';
import { ShopPicker } from '../orders/ShopPicker';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/dates';
import type { OrderListItem } from '../orders/OrdersTab';

export function PaymentNew({ shopId: initial, orderId }: { shopId?: number; orderId?: number }) {
  const [shopId, setShopId] = useState(initial);
  if (!shopId) return <ShopPicker title="To'lov" onPick={setShopId} />;
  return <PaymentForm shopId={shopId} orderId={orderId} />;
}

function PaymentForm({ shopId, orderId }: { shopId: number; orderId?: number }) {
  const nav = useNav();
  const shop = useApi<any>(`/shops/${shopId}`);
  const open = useApi<{ orders: OrderListItem[] }>(`/orders?shopId=${shopId}&unpaid=1`);
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<'CASH' | 'CARD' | 'TRANSFER'>('CASH');
  const [target, setTarget] = useState<number | null>(orderId ?? null);
  const [date, setDate] = useState(localDate());
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(uid());
  const balance = shop.data?.balance.balance ?? 0;
  const invoices = (open.data?.orders ?? []).slice().reverse(); // oldest first
  const targetOrder = invoices.find((o) => o.id === target);

  useMainButton({
    text: amount ? `Saqlash · ${formatMoney(amount)}` : 'Saqlash',
    disabled: !amount,
    progress: busy,
    onClick: async () => {
      setBusy(true);
      try {
        const r = await api.post('/payments', { shopId, amount, method, date, targetOrderId: target, comment: comment || null, idempotencyKey: key.current });
        invalidate('/shops', '/orders', '/debtors', '/payments', '/cash', '/today');
        toast(r.balance > 0 ? `To'lov saqlandi ✅ Qarz: ${formatMoney(r.balance)}` : r.balance < 0 ? `Saqlandi ✅ Avans: ${formatMoney(-r.balance)}` : "Saqlandi ✅ Qarz yo'q");
        if (r.documentId) {
          // Offer the receipt to the shop
          const link = await api.get(`/documents/${r.documentId}/link`).catch(() => null);
          if (link && shop.data?.shop.phones?.length !== undefined) {
            toast('Kvitansiya tayyor', { undo: () => openLink(`https://t.me/share/url?url=${encodeURIComponent(link.url)}&text=${encodeURIComponent(link.title)}`), actionLabel: "Do'konga yuborish", tone: 'info' });
          }
        }
        nav.pop();
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });

  if (!shop.data) return <Page title="To'lov"><Skeleton className="h-80" /></Page>;
  const quick = [balance > 0 ? balance : 0, targetOrder?.outstanding ?? 0, 500_000, 1_000_000].filter((v, i, a) => v > 0 && a.indexOf(v) === i).slice(0, 3);

  return (
    <Page title="To'lov" subtitle={shop.data.shop.name}>
      <Card className={cx(balance > 0 ? 'bg-danger-soft' : 'bg-ok-soft', 'shadow-none')}>
        <div className="text-[14px] text-muted">{balance >= 0 ? 'Hozirgi qarz' : 'Avans'}</div>
        <div className={cx('num text-[28px] font-bold', balance > 0 ? 'text-danger' : 'text-ok')}>{formatMoney(Math.abs(balance))}</div>
        {shop.data.balance.overdue > 0 && <div className="text-[14px] font-semibold text-danger">Muddati o'tgan: {formatMoney(shop.data.balance.overdue)}</div>}
      </Card>

      <Section title="Summa">
        <MoneyInput value={amount} onChange={setAmount} autoFocus />
        <Chips className="mt-2">
          {quick.map((v) => (
            <Chip key={v} active={amount === v} onClick={() => setAmount(v)}>
              {v === balance ? "To'liq qarz" : formatMoney(v)}
            </Chip>
          ))}
        </Chips>
      </Section>

      <Section title="Turi">
        <Segmented value={method} onChange={setMethod} options={[{ value: 'CASH', label: 'Naqd' }, { value: 'CARD', label: 'Karta' }, { value: 'TRANSFER', label: "O'tkazma" }]} />
      </Section>

      {invoices.length > 0 && (
        <Section title="Qaysi hujjatga">
          <div className="overflow-hidden rounded-[18px] bg-card shadow-card">
            <InvoiceOption active={target === null} onClick={() => setTarget(null)} title="Avtomatik (eng eskisidan)" sub={`${invoices.length} ta ochiq hujjat`} />
            {invoices.map((o) => (
              <InvoiceOption key={o.id} active={target === o.id} onClick={() => setTarget(o.id)} title={`${o.number} · ${formatDate(o.deliveryDate)}`} sub={`qoldiq ${formatMoney(o.outstanding)}`} />
            ))}
          </div>
        </Section>
      )}

      <Section title="Qo'shimcha">
        <div className="space-y-3">
          <Field label={`Sana: ${dayLabel(date)}`}>
            <TextInput type="date" value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Izoh">
            <TextInput value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
        </div>
      </Section>
    </Page>
  );
}

function InvoiceOption({ active, onClick, title, sub }: { active: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button onClick={onClick} className="flex min-h-[56px] w-full items-center gap-3 border-b border-line px-4 py-2 text-left last:border-0">
      <span className={cx('flex h-6 w-6 items-center justify-center rounded-full border-2', active ? 'border-brand bg-brand' : 'border-line')}>
        {active && <span className="h-2 w-2 rounded-full bg-white" />}
      </span>
      <span className="flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-[13px] text-muted">{sub}</span>
      </span>
    </button>
  );
}
