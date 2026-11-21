import { useEffect, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Card, Chip, Chips, EmptyState, Field, List, MoneyInput, Row, SkeletonList, Stepper, TextInput, cx } from '../../ui/kit';
import { ChoiceSheet } from '../../ui/sheet';
import { Icon } from '../../ui/icons';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { toast } from '../../ui/toast';
import { formatQty, splitCans } from '@shared/qty';
import { formatDate } from '@shared/dates';

/** Inventarizatsiya: enter real counts, see differences, save corrections. */
export function StockCountScreen() {
  const nav = useNav();
  const { data } = useApi<{ items: any[] }>('/stock-counts/sheet');
  const [counted, setCounted] = useState<Record<number, number>>({});
  const [cost, setCost] = useState<Record<number, number | null>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setCounted(Object.fromEntries(data.items.map((i) => [i.productId, i.expectedCans])));
  }, [data]);
  const diffs = (data?.items ?? []).filter((i) => (counted[i.productId] ?? i.expectedCans) !== i.expectedCans);

  useMainButton({
    text: diffs.length ? `Saqlash · ${diffs.length} ta farq` : 'Saqlash',
    progress: busy,
    disabled: !data,
    onClick: async () => {
      setBusy(true);
      try {
        const r = await api.post('/stock-counts', {
          note: note || null,
          items: data!.items.map((i) => ({ productId: i.productId, countedCans: counted[i.productId] ?? i.expectedCans, costPerPack: cost[i.productId] ?? null })),
        });
        invalidate('/products', '/stock');
        toast(r.diffs.length ? `Saqlandi ✅ ${r.diffs.length} ta tuzatish` : "Saqlandi ✅ Farq yo'q");
        nav.pop();
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });

  if (!data) return <Page title="Inventarizatsiya"><SkeletonList /></Page>;
  return (
    <Page title="Inventarizatsiya" subtitle="Omborda haqiqatda nechta bor?">
      <div className="space-y-2">
        {data.items.map((i) => {
          const c = counted[i.productId] ?? i.expectedCans;
          const { packs, cans } = splitCans(c, i.packSize);
          const diff = c - i.expectedCans;
          return (
            <Card key={i.productId} className={cx(diff !== 0 && 'ring-2 ring-warn')}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{i.flavour}</div>
                  <div className="text-[12.5px] text-muted">hisobda: {formatQty(i.expectedCans, i.packSize)}</div>
                  {diff !== 0 && <div className={cx('text-[13px] font-semibold', diff < 0 ? 'text-danger' : 'text-ok')}>{diff > 0 ? '+' : ''}{formatQty(diff, i.packSize)}</div>}
                </div>
                <Stepper size="md" value={packs} label="blok" onChange={(v) => setCounted((x) => ({ ...x, [i.productId]: v * i.packSize + cans }))} />
                <Stepper size="md" value={cans} max={i.packSize - 1} label="dona" onChange={(v) => setCounted((x) => ({ ...x, [i.productId]: packs * i.packSize + v }))} />
              </div>
              {diff > 0 && i.expectedCans === 0 && (
                <Field label="Kirim narxi (blok) — boshlang'ich qoldiq uchun" hint="Bo'sh qoldirilsa mahsulot kirim narxi olinadi">
                  <MoneyInput value={cost[i.productId] ?? null} onChange={(v) => setCost((x) => ({ ...x, [i.productId]: v }))} placeholder={String(i.buyPricePerPack ?? '')} />
                </Field>
              )}
            </Card>
          );
        })}
      </div>
      <Field label="Izoh">
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="Masalan: oy oxiri" />
      </Field>
    </Page>
  );
}

type AdjustType = 'SAMPLE_OUT' | 'DAMAGE' | 'EXPIRED' | 'WRITE_OFF';

/** Samples, damage, expiry, write-off. */
export function StockAdjustScreen() {
  const nav = useNav();
  const products = useApi<{ products: any[] }>('/products');
  const shops = useApi<{ shops: any[] }>('/shops');
  const [type, setType] = useState<AdjustType>('DAMAGE');
  const [productId, setProductId] = useState<number | null>(null);
  const [qty, setQty] = useState(0);
  const [shopId, setShopId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [sheet, setSheet] = useState<'' | 'product' | 'shop'>('');
  const [busy, setBusy] = useState(false);
  const p = products.data?.products.find((x) => x.id === productId);
  const { packs, cans } = splitCans(qty, p?.packSize ?? 24);
  const labels: Record<AdjustType, string> = { DAMAGE: 'Shikastlandi', EXPIRED: "Muddati o'tdi", SAMPLE_OUT: 'Namuna', WRITE_OFF: 'Hisobdan chiqarish' };

  useMainButton({
    text: 'Saqlash',
    disabled: !productId || !qty || (type === 'SAMPLE_OUT' && !shopId),
    progress: busy,
    onClick: async () => {
      setBusy(true);
      try {
        await api.post('/stock/adjust', { productId, type, qtyCans: qty, shopId, reason: reason || null });
        invalidate('/products', '/stock', '/shops');
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
    <Page title="Ombor harakati">
      <Chips>
        {(Object.keys(labels) as AdjustType[]).map((k) => (
          <Chip key={k} active={type === k} onClick={() => setType(k)}>
            {labels[k]}
          </Chip>
        ))}
      </Chips>
      <div className="mt-2 px-1 text-[13px] text-muted">
        {type === 'WRITE_OFF' ? "Shikastlangan zaxiradan butunlay chiqariladi." : type === 'SAMPLE_OUT' ? "Do'konga tekin namuna — lead holati «Namuna berildi» bo'ladi." : 'Sotiladigan zaxiradan shikastlanganlar hisobiga o‘tadi.'}
      </div>
      <div className="mt-4 space-y-4">
        <Field label="Mahsulot">
          <button className="flex h-[52px] w-full items-center justify-between rounded-[14px] border border-line bg-card px-4 text-left" onClick={() => setSheet('product')}>
            <span className={p ? '' : 'text-muted'}>{p ? `${p.flavour} (bor: ${formatQty(type === 'WRITE_OFF' ? p.stock.damaged : p.stock.inStock, p.packSize)})` : 'Tanlang'}</span>
            <Icon name="chevronDown" className="text-muted" />
          </button>
        </Field>
        <Card className="flex items-center justify-around">
          <Stepper value={packs} label="blok" onChange={(v) => setQty(v * (p?.packSize ?? 24) + cans)} />
          <Stepper value={cans} max={(p?.packSize ?? 24) - 1} label="dona" onChange={(v) => setQty(packs * (p?.packSize ?? 24) + v)} />
        </Card>
        {type === 'SAMPLE_OUT' && (
          <Field label="Do'kon / lead">
            <button className="flex h-[52px] w-full items-center justify-between rounded-[14px] border border-line bg-card px-4 text-left" onClick={() => setSheet('shop')}>
              <span className={shopId ? '' : 'text-muted'}>{shops.data?.shops.find((s) => s.id === shopId)?.name ?? 'Tanlang'}</span>
              <Icon name="chevronDown" className="text-muted" />
            </button>
          </Field>
        )}
        <Field label="Sabab">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <ChoiceSheet open={sheet === 'product'} onClose={() => setSheet('')} title="Mahsulot" value={productId} options={(products.data?.products ?? []).map((x) => ({ value: x.id, label: x.flavour, sub: `bor: ${formatQty(x.stock.inStock, x.packSize)}` }))} onPick={setProductId} />
      <ChoiceSheet open={sheet === 'shop'} onClose={() => setSheet('')} title="Do'kon" value={shopId} options={(shops.data?.shops ?? []).map((s) => ({ value: s.id, label: s.name }))} onPick={setShopId} />
    </Page>
  );
}

/** Batches with expiry dates (oldest expiry first = sold first). */
export function BatchesScreen() {
  const { data } = useApi<{ batches: any[] }>('/stock/batches');
  return (
    <Page title="Partiyalar va muddatlar">
      {!data ? (
        <SkeletonList />
      ) : data.batches.length === 0 ? (
        <EmptyState icon="layers" title="Omborda partiya yo'q" />
      ) : (
        <List>
          {data.batches.map((b) => (
            <Row
              key={b.id}
              title={b.flavour}
              subtitle={`${formatQty(b.remainingCans, b.packSize)} qoldi${b.supplierOrder ? ' · ' + b.supplierOrder : ''}`}
              right={
                b.expiry ? (
                  <Badge tone={b.expired ? 'danger' : b.expiringSoon ? 'warn' : 'grey'}>
                    {b.expired ? "o'tgan " : ''}
                    {formatDate(b.expiry)}
                  </Badge>
                ) : (
                  <span className="text-[13px] text-muted">muddatsiz</span>
                )
              }
            />
          ))}
        </List>
      )}
    </Page>
  );
}
