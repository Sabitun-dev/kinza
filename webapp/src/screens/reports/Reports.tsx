import { lazy, Suspense, useState } from 'react';
import { Page } from '../../ui/page';
import { Button, Card, Chip, Chips, EmptyState, Field, IconButton, List, Money, MoneyInput, Row, Section, Segmented, Skeleton, SkeletonList, Stat, TextInput, cx } from '../../ui/kit';
import { Sheet } from '../../ui/sheet';
import { PhotoPicker } from '../../ui/photo';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { useSession } from '../../session';
import { toast } from '../../ui/toast';
import { confirmDialog } from '../../tg';
import { addDays, dayLabel, localDate } from '../../util';
import { formatMoney } from '@shared/money';
import { formatDate } from '@shared/dates';

const RevenueChart = lazy(() => import('./RevenueChart'));

type Period = 'today' | 'week' | 'month' | 'custom';
function periodRange(p: Period, custom: { from: string; to: string }) {
  const today = localDate();
  if (p === 'today') return { from: today, to: today };
  if (p === 'week') return { from: addDays(today, -6), to: today };
  if (p === 'month') return { from: today.slice(0, 8) + '01', to: today };
  return custom;
}

function PeriodPicker({ p, setP, custom, setCustom }: { p: Period; setP: (p: Period) => void; custom: { from: string; to: string }; setCustom: (c: { from: string; to: string }) => void }) {
  return (
    <>
      <Chips>
        <Chip active={p === 'today'} onClick={() => setP('today')}>Bugun</Chip>
        <Chip active={p === 'week'} onClick={() => setP('week')}>Hafta</Chip>
        <Chip active={p === 'month'} onClick={() => setP('month')}>Oy</Chip>
        <Chip active={p === 'custom'} onClick={() => setP('custom')}>Sana tanlash</Chip>
      </Chips>
      {p === 'custom' && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <TextInput type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          <TextInput type="date" value={custom.to} min={custom.from} max={localDate()} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
        </div>
      )}
    </>
  );
}

/** Owner dashboard. Every number opens its list. */
export function DashboardScreen() {
  const nav = useNav();
  const [p, setP] = useState<Period>('month');
  const [custom, setCustom] = useState({ from: addDays(localDate(), -30), to: localDate() });
  const { from, to } = periodRange(p, custom);
  const { data } = useApi<any>(`/dashboard?from=${from}&to=${to}`);
  return (
    <Page title="Hisobotlar" subtitle={`${formatDate(from)} — ${formatDate(to)}`}>
      <PeriodPicker p={p} setP={setP} custom={custom} setCustom={setCustom} />
      {!data ? (
        <div className="mt-3 space-y-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <>
          <Card className="mt-3 bg-brand text-brand-ink">
            <div className="text-[14px] opacity-80">Sof foyda</div>
            <div className="num text-[30px] leading-tight font-bold">{formatMoney(data.netProfit)}</div>
            <div className="mt-1 text-[13px] opacity-80">
              Yalpi {formatMoney(data.grossProfit)} − xarajat {formatMoney(data.expenses)}
            </div>
          </Card>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat label="Tushum (yetkazilgan)" value={formatMoney(data.revenue)} sub={`${data.orderCount} ta hujjat`} onClick={() => nav.setTab('orders')} />
            <Stat label="Yig'ilgan pul" value={formatMoney(data.collected)} onClick={() => nav.push('payments')} />
            <Stat label="Yalpi foyda" value={formatMoney(data.grossProfit)} tone="ok" />
            <Stat label="Xarajatlar" value={formatMoney(data.expenses)} onClick={() => nav.push('expenses')} />
            <Stat label="Sotilgan" value={`${data.packsSold} blok`} />
            <Stat label="O'rtacha buyurtma" value={formatMoney(data.avgOrder)} />
            <Stat label="Yangi do'konlar" value={String(data.newShops)} onClick={() => nav.setTab('shops')} />
            <Stat label="Qarz (hozir)" value={formatMoney(data.debt)} sub={data.overdue ? `muddati o'tgan ${formatMoney(data.overdue)}` : undefined} tone={data.overdue ? 'danger' : undefined} onClick={() => nav.push('debtors')} />
          </div>
          {data.series.length > 1 && (
            <Section title="Tushum kunlar bo'yicha">
              <Card padded={false} className="p-3">
                <Suspense fallback={<Skeleton className="h-[180px]" />}>
                  <RevenueChart series={data.series} />
                </Suspense>
              </Card>
            </Section>
          )}
          <Rank title="Eng ko'p olgan do'konlar" rows={data.topShops.map((s: any) => ({ key: s.shopId, label: s.name, value: formatMoney(s.total), onClick: () => nav.push('shop', { id: s.shopId }) }))} />
          <Rank title="Ommabop ta'mlar" rows={data.topFlavours.map((f: any) => ({ key: f.productId, label: f.flavour, value: `${f.packs} blok` }))} />
          <Rank title="Sekin sotilayotgan ta'mlar" rows={data.slowFlavours.map((f: any) => ({ key: f.productId, label: f.flavour, value: `${f.packs} blok` }))} />
          {data.agentRanking.length > 0 && (
            <Rank title="Agentlar" rows={data.agentRanking.map((a: any) => ({ key: a.userId, label: a.name, value: formatMoney(a.revenue), sub: `${a.orders} ta · yig'di ${formatMoney(a.collected)}`, onClick: () => nav.push('commission', { userId: a.userId }) }))} />
          )}
          {data.expensesByCategory.length > 0 && <Rank title="Xarajatlar turi bo'yicha" rows={data.expensesByCategory.map((e: any) => ({ key: e.name, label: e.name, value: formatMoney(e.amount) }))} />}
          <Button block variant="soft" icon="download" className="mt-5" onClick={() => nav.push('exports')}>
            Excel / CSV eksport
          </Button>
        </>
      )}
    </Page>
  );
}

function Rank({ title, rows }: { title: string; rows: { key: string | number; label: string; value: string; sub?: string; onClick?: () => void }[] }) {
  if (!rows.length) return null;
  return (
    <Section title={title}>
      <List>
        {rows.map((r, i) => (
          <Row key={r.key} left={<span className="w-5 text-center text-[14px] font-bold text-muted">{i + 1}</span>} title={r.label} subtitle={r.sub} right={<span className="num font-semibold">{r.value}</span>} onClick={r.onClick} />
        ))}
      </List>
    </Section>
  );
}

// ── Expenses ──
export function ExpensesScreen() {
  const nav = useNav();
  const [p, setP] = useState<Period>('month');
  const [custom, setCustom] = useState({ from: addDays(localDate(), -30), to: localDate() });
  const { from, to } = periodRange(p, custom);
  const { data } = useApi<{ expenses: any[]; total: number }>(`/expenses?from=${from}&to=${to}`);
  return (
    <Page title="Xarajatlar" subtitle={data ? `Jami: ${formatMoney(data.total)}` : undefined} right={<IconButton icon="plus" label="Qo'shish" tone="brand" onClick={() => nav.push('expense-edit')} />}>
      <PeriodPicker p={p} setP={setP} custom={custom} setCustom={setCustom} />
      <div className="mt-3">
        {!data ? (
          <SkeletonList />
        ) : data.expenses.length === 0 ? (
          <EmptyState icon="receipt" title="Xarajat yo'q" action={<Button icon="plus" onClick={() => nav.push('expense-edit')}>Xarajat qo'shish</Button>} />
        ) : (
          <List>
            {data.expenses.map((e) => (
              <Row key={e.id} title={e.category} subtitle={`${dayLabel(e.date)}${e.comment ? ' · ' + e.comment : ''}${e.receiptUrl ? ' · 🧾' : ''}`} right={<Money value={e.amount} className="font-semibold" />} onClick={() => nav.push('expense-edit', { expense: e })} />
            ))}
          </List>
        )}
      </div>
    </Page>
  );
}

export function ExpenseEdit({ expense }: { expense?: any }) {
  const nav = useNav();
  const cats = useApi<{ categories: { id: number; name: string }[] }>('/expense-categories');
  const [categoryId, setCategoryId] = useState<number | null>(expense?.categoryId ?? null);
  const [amount, setAmount] = useState<number | null>(expense?.amount ?? null);
  const [date, setDate] = useState(expense?.date ?? localDate());
  const [comment, setComment] = useState(expense?.comment ?? '');
  const [receipt, setReceipt] = useState<{ id: number; url: string } | null>(expense?.receiptFileId ? { id: expense.receiptFileId, url: expense.receiptUrl } : null);
  const [newCat, setNewCat] = useState(false);
  const [busy, setBusy] = useState(false);
  const cat = categoryId ?? cats.data?.categories[0]?.id ?? null;

  useMainButton({
    text: 'Saqlash',
    disabled: !amount || !cat,
    progress: busy,
    onClick: async () => {
      setBusy(true);
      try {
        const body = { categoryId: cat, amount, date, comment: comment || null, receiptFileId: receipt?.id ?? null };
        if (expense) await api.patch(`/expenses/${expense.id}`, body);
        else await api.post('/expenses', body);
        invalidate('/expenses', '/dashboard');
        toast('Saqlandi ✅');
        nav.pop();
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });

  return (
    <Page title={expense ? 'Xarajat' : 'Yangi xarajat'}>
      <div className="space-y-4">
        <Field label="Turi">
          <div className="flex flex-wrap gap-2">
            {cats.data?.categories.map((k) => (
              <Chip key={k.id} active={cat === k.id} onClick={() => setCategoryId(k.id)}>
                {k.name}
              </Chip>
            ))}
            <Chip onClick={() => setNewCat(true)} icon="plus">
              Yangi
            </Chip>
          </div>
        </Field>
        <Field label="Summa">
          <MoneyInput value={amount} onChange={setAmount} autoFocus={!expense} />
        </Field>
        <Field label={`Sana: ${dayLabel(date)}`}>
          <TextInput type="date" value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Izoh">
          <TextInput value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <Field label="Chek rasmi (ixtiyoriy)">
          <PhotoPicker kind="RECEIPT_PHOTO" url={receipt?.url} label="Chek" onUploaded={setReceipt} />
        </Field>
        {expense && (
          <Button
            block
            variant="danger"
            onClick={async () => {
              if (!(await confirmDialog("Xarajatni o'chirasizmi?"))) return;
              await api.post(`/expenses/${expense.id}/void`);
              invalidate('/expenses', '/dashboard');
              toast("O'chirildi");
              nav.pop();
            }}
          >
            O'chirish
          </Button>
        )}
      </div>
      {newCat && <NewCategorySheet onClose={(id) => (setNewCat(false), id && setCategoryId(id))} />}
    </Page>
  );
}

function NewCategorySheet({ onClose }: { onClose: (id?: number) => void }) {
  const [name, setName] = useState('');
  return (
    <Sheet
      open
      onClose={() => onClose()}
      title="Yangi xarajat turi"
      footer={
        <Button
          block
          disabled={!name.trim()}
          onClick={async () => {
            try {
              const r = await api.post('/expense-categories', { name: name.trim() });
              invalidate('/expense-categories');
              onClose(r.id);
            } catch (e) {
              toast.error(e);
            }
          }}
        >
          Saqlash
        </Button>
      }
    >
      <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Masalan: Telefon" />
    </Sheet>
  );
}

// ── Exports ──
const KINDS: { kind: string; label: string; period: boolean }[] = [
  { kind: 'sales', label: 'Sotuvlar (har bir qator)', period: true },
  { kind: 'debts', label: 'Qarzdorlar', period: false },
  { kind: 'stock', label: 'Ombor qoldig‘i', period: false },
  { kind: 'payments', label: "To'lovlar", period: true },
  { kind: 'expenses', label: 'Xarajatlar', period: true },
  { kind: 'supplier', label: 'Toshkent buyurtmalari', period: true },
];

export function ExportsScreen() {
  const [p, setP] = useState<Period>('month');
  const [custom, setCustom] = useState({ from: addDays(localDate(), -30), to: localDate() });
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [busy, setBusy] = useState('');
  const { from, to } = periodRange(p, custom);
  return (
    <Page title="Eksport" subtitle="Fayl chatingizga keladi">
      <Segmented value={format} onChange={setFormat} options={[{ value: 'xlsx', label: 'Excel' }, { value: 'csv', label: 'CSV' }]} />
      <div className="mt-3">
        <PeriodPicker p={p} setP={setP} custom={custom} setCustom={setCustom} />
      </div>
      <List className="mt-3">
        {KINDS.map((k) => (
          <Row
            key={k.kind}
            title={k.label}
            subtitle={k.period ? `${formatDate(from)} — ${formatDate(to)}` : 'Hozirgi holat'}
            right={busy === k.kind ? <span className="text-[13px] text-muted">…</span> : undefined}
            onClick={async () => {
              setBusy(k.kind);
              try {
                const r = await api.post('/exports', { kind: k.kind, format, from, to });
                toast(`Chatingizga yuborildi ✅ (${r.rows} qator)`);
              } catch (e) {
                toast.error(e);
              } finally {
                setBusy('');
              }
            }}
          />
        ))}
      </List>
    </Page>
  );
}

/** Commission statement (owner for any agent; agent for themselves). */
export function CommissionScreen({ userId }: { userId?: number }) {
  const { user } = useSession();
  const [month, setMonth] = useState(localDate().slice(0, 7));
  const { data } = useApi<any>(`/commission?userId=${userId ?? user.id}&month=${month}`);
  const prev = (m: string) => {
    const d = new Date(m + '-01T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  };
  return (
    <Page title={data ? data.user.name : 'Natijalar'} subtitle={month}>
      <Chips>
        <Chip active={month === localDate().slice(0, 7)} onClick={() => setMonth(localDate().slice(0, 7))}>Shu oy</Chip>
        <Chip active={month === prev(localDate().slice(0, 7))} onClick={() => setMonth(prev(localDate().slice(0, 7)))}>O'tgan oy</Chip>
      </Chips>
      {!data ? (
        <Skeleton className="mt-3 h-40" />
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat label="Sotuv (yetkazilgan)" value={formatMoney(data.sales)} />
            <Stat label="Yig'ilgan pul" value={formatMoney(data.collected)} />
          </div>
          <Card className={cx('mt-3', data.user.mode !== 'NONE' && 'bg-brand text-brand-ink')}>
            <div className="text-[14px] opacity-80">Komissiya {data.user.mode === 'NONE' ? 'belgilanmagan' : `(${data.user.bp / 100}% ${data.user.mode === 'COLLECTED' ? "yig'ilgan puldan" : 'sotuvdan'})`}</div>
            <div className="num text-[28px] font-bold">{formatMoney(data.commission)}</div>
          </Card>
          {data.payments.length > 0 && (
            <Section title="Yig'ilgan pullar">
              <List>
                {data.payments.map((p: any) => (
                  <Row key={p.id} title={p.shop} subtitle={formatDate(p.date)} right={<Money value={p.amount} />} />
                ))}
              </List>
            </Section>
          )}
          {data.orders.length > 0 && (
            <Section title="Sotuvlar">
              <List>
                {data.orders.map((o: any) => (
                  <Row key={o.id} title={o.shop} subtitle={`${o.number} · ${formatDate(o.date)}`} right={<Money value={o.total} />} />
                ))}
              </List>
            </Section>
          )}
        </>
      )}
    </Page>
  );
}
