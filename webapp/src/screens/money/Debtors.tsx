import { useState } from 'react';
import { Page } from '../../ui/page';
import { Card, Chip, Chips, EmptyState, ErrorBox, Money, Segmented, SkeletonList, cx } from '../../ui/kit';
import { ChoiceSheet } from '../../ui/sheet';
import { Icon } from '../../ui/icons';
import { useApi } from '../../api';
import { useNav } from '../../nav';
import { useSession } from '../../session';
import { openLink, haptic } from '../../tg';
import { callPhone } from '../../util';
import { formatMoney } from '@shared/money';

interface Debtor {
  shopId: number;
  name: string;
  phones: string[];
  address: string | null;
  agentName: string | null;
  balance: number;
  overdue: number;
  ageDays: number;
  buckets: { b0: number; b8: number; b30: number };
  lastPaymentAt: string | null;
}

type Bucket = 'all' | 'b0' | 'b8' | 'b30' | 'overdue';

/** Qarzdorlar: sorted by amount or age, 0–7 / 8–30 / 30+ day buckets. */
export function DebtorsScreen() {
  const nav = useNav();
  const { settings } = useSession();
  const [sort, setSort] = useState<'amount' | 'age'>('amount');
  const [bucket, setBucket] = useState<Bucket>('all');
  const [remind, setRemind] = useState<Debtor | null>(null);
  const { data, error, reload } = useApi<{ rows: Debtor[]; totals: { total: number; overdue: number; b0: number; b8: number; b30: number } }>(`/debtors?sort=${sort}`);
  const rows = (data?.rows ?? []).filter((r) => (bucket === 'all' ? true : bucket === 'overdue' ? r.overdue > 0 : r.buckets[bucket] > 0));

  const reminderText = (d: Debtor) =>
    `Assalomu alaykum! ${d.name} — ${settings.businessName}dan eslatma: qarzingiz ${formatMoney(d.balance)}${d.overdue > 0 ? ` (muddati o'tgan: ${formatMoney(d.overdue)})` : ''}. Iltimos, to'lovni amalga oshiring. Rahmat!`;

  return (
    <Page title="Qarzdorlar" subtitle={data ? `${data.rows.length} ta do'kon` : undefined}>
      {data && (
        <Card className="bg-brand text-brand-ink">
          <div className="text-[14px] opacity-80">Jami qarz</div>
          <div className="num text-[30px] font-bold">{formatMoney(data.totals.total)}</div>
          {data.totals.overdue > 0 && <div className="text-[14px] font-semibold text-accent">Muddati o'tgan: {formatMoney(data.totals.overdue)}</div>}
        </Card>
      )}
      {data && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {(
            [
              ['b0', '0–7 kun', data.totals.b0],
              ['b8', '8–30 kun', data.totals.b8],
              ['b30', '30+ kun', data.totals.b30],
            ] as [Bucket, string, number][]
          ).map(([k, label, v]) => (
            <button
              key={k}
              onClick={() => (haptic.tap(), setBucket(bucket === k ? 'all' : k))}
              className={cx('rounded-[16px] p-3 text-left shadow-card', bucket === k ? 'bg-brand text-brand-ink' : 'bg-card')}
            >
              <div className={cx('text-[12px]', bucket === k ? 'opacity-80' : 'text-muted')}>{label}</div>
              <div className={cx('num text-[15px] font-bold', k === 'b30' && bucket !== k && v > 0 && 'text-danger')}>{formatMoney(v).replace(" so'm", '')}</div>
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Chips className="flex-1">
          <Chip active={bucket === 'overdue'} tone="danger" onClick={() => setBucket(bucket === 'overdue' ? 'all' : 'overdue')}>
            Muddati o'tgan
          </Chip>
        </Chips>
        <div className="w-[170px]">
          <Segmented value={sort} onChange={setSort} options={[{ value: 'amount', label: 'Summa' }, { value: 'age', label: 'Muddat' }]} />
        </div>
      </div>
      <div className="mt-3 space-y-3">
        {error && <ErrorBox error={error} onRetry={reload} />}
        {!data && !error && <SkeletonList />}
        {data && rows.length === 0 && <EmptyState icon="check" title="Qarzdor yo'q 🎉" />}
        {rows.map((d) => (
          <Card key={d.shopId} padded={false}>
            <button className="block w-full p-4 pb-2 text-left" onClick={() => nav.push('shop', { id: d.shopId })}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[17px] font-bold">{d.name}</div>
                  <div className="truncate text-[13px] text-muted">
                    {d.ageDays} kun · {d.agentName ?? d.address ?? ''}
                  </div>
                </div>
                <div className="text-right">
                  <Money value={d.balance} className="text-[17px] font-bold" />
                  {d.overdue > 0 && <div className="text-[12px] font-semibold text-danger">⚠️ {formatMoney(d.overdue)}</div>}
                </div>
              </div>
            </button>
            <div className="grid grid-cols-3 border-t border-line">
              <RowBtn icon="phone" label="Qo'ng'iroq" onClick={() => (d.phones[0] ? callPhone(d.phones[0]) : undefined)} disabled={!d.phones[0]} />
              <RowBtn icon="bell" label="Eslatish" onClick={() => setRemind(d)} />
              <RowBtn icon="wallet" label="To'lov" onClick={() => nav.push('payment-new', { shopId: d.shopId })} primary />
            </div>
          </Card>
        ))}
      </div>
      <ChoiceSheet
        open={!!remind}
        onClose={() => setRemind(null)}
        title="Eslatma yuborish"
        options={[
          { value: 'tg', label: 'Telegram orqali', sub: 'Chatni tanlaysiz' },
          ...(remind?.phones[0] ? [{ value: 'sms', label: 'SMS', sub: remind.phones[0] }] : []),
        ]}
        onPick={(v) => {
          if (!remind) return;
          const text = reminderText(remind);
          if (v === 'tg') openLink(`https://t.me/share/url?url=${encodeURIComponent(' ')}&text=${encodeURIComponent(text)}`);
          else window.location.href = `sms:${remind.phones[0]}?body=${encodeURIComponent(text)}`;
        }}
      />
    </Page>
  );
}

function RowBtn({ icon, label, onClick, primary, disabled }: { icon: 'phone' | 'bell' | 'wallet'; label: string; onClick: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={() => (haptic.tap(), onClick())}
      className={cx('flex h-12 items-center justify-center gap-1.5 border-r border-line text-[14px] font-semibold last:border-0 disabled:opacity-40', primary ? 'text-brand' : 'text-text')}
    >
      <Icon name={icon} size={18} />
      {label}
    </button>
  );
}
