import { useEffect, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, EmptyState, Field, List, Money, MoneyInput, Row, Section, Segmented, Skeleton, SkeletonList, StatusBadge, Stepper, TextInput, cx } from '../../ui/kit';
import { Sheet } from '../../ui/sheet';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { useIsOwner } from '../../session';
import { toast } from '../../ui/toast';
import { confirmDialog } from '../../tg';
import { ago, dayLabel, localDate } from '../../util';
import { formatMoney } from '@shared/money';
import { formatQty, splitCans } from '@shared/qty';
import { formatDate } from '@shared/dates';

/** "Toshkentga buyurtma": proposal per flavour, editable before creating the order. */
export function SupplierProposal() {
  const nav = useNav();
  const { data } = useApi<any>('/supplier/proposal');
  const [packs, setPacks] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setPacks(Object.fromEntries(data.lines.map((l: any) => [l.productId, l.proposedPacks])));
  }, [data]);
  const lines: any[] = data?.lines ?? [];
  const totalPacks = Object.values(packs).reduce((s, v) => s + v, 0);
  const cost = lines.reduce((s, l) => s + (packs[l.productId] ?? 0) * (l.buyPricePerPack + data.cargoPerPack), 0);
  const revenue = lines.reduce((s, l) => s + (packs[l.productId] ?? 0) * l.sellPerPack, 0);

  useMainButton({
    text: `Buyurtma yaratish · ${totalPacks} blok`,
    disabled: !totalPacks,
    progress: busy,
    onClick: async () => {
      setBusy(true);
      try {
        const r = await api.post('/supplier-orders', {
          arrivalDate: data.arrivalDate,
          coverUntil: data.coverUntil,
          lines: lines.map((l: any) => ({ productId: l.productId, orderedPacks: packs[l.productId] ?? 0, proposedPacks: l.proposedPacks })),
        });
        invalidate('/supplier');
        toast(`Buyurtma ${r.number} tayyor ✅`);
        nav.replace('supplier-order', { id: r.id });
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });

  if (!data) return <Page title="Toshkentga buyurtma"><SkeletonList /></Page>;
  return (
    <Page title="Toshkentga buyurtma" subtitle={`Kelishi: ${dayLabel(data.arrivalDate)} · ${formatDate(data.coverUntil)} gacha buyurtmalar`}>
      <Card className="bg-brand text-brand-ink">
        <div className="text-[14px] opacity-80">Buyurtma berish: {dayLabel(data.orderDay)} {data.cutoff} gacha</div>
        <div className="num mt-1 text-[28px] font-bold">{totalPacks} blok</div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[13px]">
          <div>
            <div className="opacity-70">Xarajat</div>
            <div className="num font-semibold">{formatMoney(cost)}</div>
          </div>
          <div>
            <div className="opacity-70">Tushum</div>
            <div className="num font-semibold">{formatMoney(revenue)}</div>
          </div>
          <div>
            <div className="opacity-70">Foyda</div>
            <div className="num font-semibold text-accent">{formatMoney(revenue - cost)}</div>
          </div>
        </div>
      </Card>
      <div className="mt-2 px-1 text-[13px] text-muted">Hisob: buyurtmalar − omborda va yo'ldagi + zaxira, butun blokka va eng kam miqdorga yaxlitlangan.</div>
      <div className="mt-3 space-y-2">
        {lines.map((l: any) => (
          <Card key={l.productId} className={cx('flex items-center gap-3', (packs[l.productId] ?? 0) > 0 && 'ring-2 ring-brand')}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-bold">{l.flavour}</div>
              <div className="text-[12.5px] text-muted">
                buyurtma {l.ordersPacks} · bor {l.inStockPacks}
                {l.incomingPacks ? ` · yo'lda ${l.incomingPacks}` : ''} · taklif {l.proposedPacks}
              </div>
            </div>
            <Stepper value={packs[l.productId] ?? 0} onChange={(v) => setPacks((p) => ({ ...p, [l.productId]: v }))} label="blok" />
          </Card>
        ))}
      </div>
      <Button block variant="ghost" className="mt-3" onClick={() => nav.push('supplier-orders')}>
        Oldingi buyurtmalar
      </Button>
    </Page>
  );
}

export function SupplierOrders() {
  const nav = useNav();
  const owner = useIsOwner();
  const { data } = useApi<{ orders: any[] }>('/supplier-orders');
  const bal = useApi<any>(owner ? '/supplier/balance' : null);
  const [payOpen, setPayOpen] = useState(false);
  return (
    <Page title="Toshkent buyurtmalari" right={owner ? <Button size="sm" icon="plus" onClick={() => nav.push('supplier-proposal')}>Yangi</Button> : undefined}>
      {owner && bal.data && (
        <Card className="mb-3" onClick={() => setPayOpen(true)}>
          <div className="text-[14px] text-muted">Yetkazib beruvchiga qarzim</div>
          <div className={cx('num text-[24px] font-bold', bal.data.balance > 0 && 'text-danger')}>{formatMoney(bal.data.balance)}</div>
          <div className="text-[13px] text-brand">To'lov kiritish →</div>
        </Card>
      )}
      {!data ? (
        <SkeletonList />
      ) : data.orders.length === 0 ? (
        <EmptyState icon="truck" title="Hali buyurtma yo'q" />
      ) : (
        <List>
          {data.orders.map((o) => (
            <Row
              key={o.id}
              title={`${o.number} · ${o.packs} blok`}
              subtitle={o.arrivalDate ? `Kelishi: ${dayLabel(o.arrivalDate)}` : ago(o.createdAt)}
              right={<StatusBadge kind="supplier" status={o.status} small />}
              onClick={() => nav.push('supplier-order', { id: o.id })}
            />
          ))}
        </List>
      )}
      {payOpen && <SupplierPaySheet onClose={() => setPayOpen(false)} />}
    </Page>
  );
}

function SupplierPaySheet({ onClose, supplierOrderId }: { onClose: () => void; supplierOrderId?: number }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<'CASH' | 'CARD' | 'TRANSFER'>('TRANSFER');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Yetkazib beruvchiga to'lov"
      footer={
        <Button
          block
          disabled={!amount}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post('/supplier-payments', { amount, method, supplierOrderId: supplierOrderId ?? null });
              invalidate('/supplier');
              toast('Saqlandi ✅');
              onClose();
            } catch (e) {
              toast.error(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Saqlash
        </Button>
      }
    >
      <div className="space-y-3">
        <MoneyInput value={amount} onChange={setAmount} autoFocus />
        <Segmented value={method} onChange={setMethod} options={[{ value: 'CASH', label: 'Naqd' }, { value: 'CARD', label: 'Karta' }, { value: 'TRANSFER', label: "O'tkazma" }]} />
      </div>
    </Sheet>
  );
}

export function SupplierOrderDetail({ id }: { id: number }) {
  const nav = useNav();
  const owner = useIsOwner();
  const { data, reload } = useApi<{ order: any }>(`/supplier-orders/${id}`);
  const [busy, setBusy] = useState('');
  const [costOpen, setCostOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const o = data?.order;
  const act = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    setBusy(key);
    try {
      await fn();
      toast(msg);
      invalidate('/supplier');
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy('');
    }
  };
  const canReceive = o && ['DRAFT', 'ORDERED', 'IN_TRANSIT'].includes(o.status);
  useMainButton({ text: 'Qabul qilish', visible: !!canReceive, onClick: () => nav.push('supplier-receive', { id }) });

  if (!o) return <Page title="Buyurtma"><Skeleton className="h-80" /></Page>;
  const packs = o.items.reduce((s: number, i: any) => s + i.orderedPacks, 0);
  return (
    <Page title={o.number} subtitle={`${packs} blok${o.arrivalDate ? ' · kelishi ' + dayLabel(o.arrivalDate) : ''}`}>
      <StatusBadge kind="supplier" status={o.status} />
      {owner && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="md" variant="soft" icon="send" loading={busy === 'text'} onClick={() => act('text', () => api.post(`/supplier-orders/${id}/send`, { format: 'text' }), 'Chatingizga yuborildi — Toshkentga uzating')}>
            Matn
          </Button>
          <Button size="md" variant="soft" icon="file" loading={busy === 'pdf'} onClick={() => act('pdf', () => api.post(`/supplier-orders/${id}/send`, { format: 'pdf' }), 'PDF chatingizda')}>
            PDF
          </Button>
          {o.status === 'DRAFT' && (
            <Button size="md" icon="check" loading={busy === 'ordered'} onClick={() => act('ordered', () => api.post(`/supplier-orders/${id}/status`, { status: 'ORDERED' }), 'Buyurtma berildi ✅')}>
              Buyurtma berildi
            </Button>
          )}
          {o.status === 'ORDERED' && (
            <Button size="md" variant="secondary" icon="truck" loading={busy === 'transit'} onClick={() => act('transit', () => api.post(`/supplier-orders/${id}/status`, { status: 'IN_TRANSIT' }), "Yo'lda 🚚")}>
              Yo'lda
            </Button>
          )}
        </div>
      )}
      <Section title="Ta'mlar">
        <List>
          {o.items.map((i: any) => (
            <Row
              key={i.id}
              title={i.flavour}
              subtitle={
                i.receivedCans != null
                  ? `keldi: ${formatQty(i.receivedCans, i.packSize)}${i.damagedCans ? ` · shikast: ${formatQty(i.damagedCans, i.packSize)}` : ''}${i.expiry ? ` · muddat ${formatDate(i.expiry)}` : ''}`
                  : i.buyPricePerPack != null
                    ? `${formatMoney(i.buyPricePerPack)} / blok`
                    : undefined
              }
              right={
                <div className="text-right">
                  <div className="font-bold">{i.orderedPacks} blok</div>
                  {i.landedPerPack != null && <div className="text-[12px] text-muted">tannarx {formatMoney(i.landedPerPack)}</div>}
                  {i.receivedCans != null && i.receivedCans + (i.damagedCans ?? 0) !== i.orderedPacks * i.packSize && <Badge tone="warn">farq</Badge>}
                </div>
              }
            />
          ))}
        </List>
      </Section>
      {owner && (
        <Section title="Xarajatlar va to'lovlar">
          <Card>
            <Line label="Yetkazib beruvchi hisobi" value={o.invoiceAmount} />
            <Line label="Yo'l / yuk xarajati" value={o.cost} />
            {o.payments.map((p: any) => (
              <Line key={p.id} label={`To'landi · ${ago(p.paidAt)}`} value={-p.amount} />
            ))}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button size="sm" variant="soft" icon="plus" onClick={() => setCostOpen(true)}>
                Yo'l xarajati
              </Button>
              <Button size="sm" variant="soft" icon="wallet" onClick={() => setPayOpen(true)}>
                To'lov
              </Button>
            </div>
          </Card>
          {o.status !== 'RECEIVED' && o.status !== 'CANCELLED' && (
            <Button
              block
              variant="danger"
              className="mt-3"
              onClick={async () => {
                if (await confirmDialog('Buyurtmani bekor qilasizmi?')) act('cancel', () => api.post(`/supplier-orders/${id}/status`, { status: 'CANCELLED' }), 'Bekor qilindi');
              }}
            >
              Bekor qilish
            </Button>
          )}
        </Section>
      )}
      {costOpen && <CostSheet id={id} onClose={() => (setCostOpen(false), reload())} />}
      {payOpen && <SupplierPaySheet supplierOrderId={id} onClose={() => (setPayOpen(false), reload())} />}
    </Page>
  );
}

function Line({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted">{label}</span>
      <Money value={value} />
    </div>
  );
}

function CostSheet({ id, onClose }: { id: number; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  return (
    <Sheet
      open
      onClose={onClose}
      title="Yo'l / yuk xarajati"
      footer={
        <Button
          block
          disabled={!amount}
          onClick={async () => {
            try {
              await api.post(`/supplier-orders/${id}/costs`, { amount, comment: comment || undefined });
              toast('Saqlandi ✅');
              onClose();
            } catch (e) {
              toast.error(e);
            }
          }}
        >
          Saqlash
        </Button>
      }
    >
      <div className="space-y-3">
        <MoneyInput value={amount} onChange={setAmount} autoFocus />
        <TextInput value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Izoh (masalan: Isuzu, 2 reys)" />
        <div className="text-[13px] text-muted">Yo'l xarajati kelgan har bir blokka bo'lib, tannarxga qo'shiladi (qabul qilishdan oldin kiriting).</div>
      </div>
    </Sheet>
  );
}

/** "Qabul qilindi": what actually arrived, expiry per batch, damaged on arrival. */
export function SupplierReceive({ id }: { id: number }) {
  const nav = useNav();
  const owner = useIsOwner();
  const { data } = useApi<{ order: any }>(`/supplier-orders/${id}`);
  const o = data?.order;
  const [good, setGood] = useState<Record<number, number>>({});
  const [bad, setBad] = useState<Record<number, number>>({});
  const [expiry, setExpiry] = useState<Record<number, string>>({});
  const [cargo, setCargo] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (o) setGood(Object.fromEntries(o.items.map((i: any) => [i.id, i.orderedPacks * i.packSize])));
  }, [o]);

  useMainButton({
    text: 'Qabul qilindi',
    progress: busy,
    disabled: !o,
    onClick: async () => {
      setBusy(true);
      try {
        const r = await api.post(`/supplier-orders/${id}/receive`, {
          cargoCost: owner && cargo ? cargo : undefined,
          lines: o.items.map((i: any) => ({ itemId: i.id, receivedCans: good[i.id] ?? 0, damagedCans: bad[i.id] ?? 0, expiry: expiry[i.id] || null })),
        });
        invalidate('/supplier', '/products', '/stock');
        toast(r.differences.length ? `Qabul qilindi ✅ Farqlar: ${r.differences.length} ta` : 'Qabul qilindi ✅ Ombor yangilandi');
        nav.pop();
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });

  if (!o) return <Page title="Qabul qilish"><Skeleton className="h-80" /></Page>;
  return (
    <Page title="Qabul qilish" subtitle={o.number}>
      <div className="space-y-3">
        {o.items.map((i: any) => {
          const g = splitCans(good[i.id] ?? 0, i.packSize);
          const d = splitCans(bad[i.id] ?? 0, i.packSize);
          const diff = (good[i.id] ?? 0) + (bad[i.id] ?? 0) - i.orderedPacks * i.packSize;
          return (
            <Card key={i.id} className={cx(diff !== 0 && 'ring-2 ring-warn')}>
              <div className="flex items-center justify-between">
                <div className="text-[17px] font-bold">{i.flavour}</div>
                <div className="text-[13px] text-muted">buyurtma: {i.orderedPacks} blok</div>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[14px] font-medium">Keldi (butun)</span>
                <div className="flex gap-2">
                  <Stepper size="md" value={g.packs} label="blok" onChange={(v) => setGood((x) => ({ ...x, [i.id]: v * i.packSize + g.cans }))} />
                  <Stepper size="md" value={g.cans} max={i.packSize - 1} label="dona" onChange={(v) => setGood((x) => ({ ...x, [i.id]: g.packs * i.packSize + v }))} />
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[14px] font-medium text-danger">Shikastlangan</span>
                <div className="flex gap-2">
                  <Stepper size="md" value={d.packs} label="blok" onChange={(v) => setBad((x) => ({ ...x, [i.id]: v * i.packSize + d.cans }))} />
                  <Stepper size="md" value={d.cans} max={i.packSize - 1} label="dona" onChange={(v) => setBad((x) => ({ ...x, [i.id]: d.packs * i.packSize + v }))} />
                </div>
              </div>
              <Field label="Yaroqlilik muddati (ixtiyoriy)">
                <TextInput type="date" min={localDate()} value={expiry[i.id] ?? ''} onChange={(e) => setExpiry((x) => ({ ...x, [i.id]: e.target.value }))} />
              </Field>
              {diff !== 0 && <div className="mt-2 text-[13px] font-semibold text-warn">Farq: {diff > 0 ? '+' : ''}{formatQty(diff, i.packSize)}</div>}
            </Card>
          );
        })}
        {owner && (
          <Field label="Yo'l / yuk xarajati (jami)" hint={o.cost ? `Avval kiritilgan: ${formatMoney(o.cost)}` : 'Har bir blokning tannarxiga bo‘lib qo‘shiladi'}>
            <MoneyInput value={cargo} onChange={setCargo} />
          </Field>
        )}
      </div>
    </Page>
  );
}
