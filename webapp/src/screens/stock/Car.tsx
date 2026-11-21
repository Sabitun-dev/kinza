import { useEffect, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, EmptyState, List, Qty, Row, Skeleton, SkeletonList, Stepper, cx } from '../../ui/kit';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { toast } from '../../ui/toast';
import { formatQty } from '@shared/qty';

/** "Mashina": what is in my car, with Yuklash / Tushirish. */
export function CarScreen() {
  const nav = useNav();
  const { data } = useApi<{ products: any[] }>('/car');
  const inCar = (data?.products ?? []).filter((p) => p.inCar > 0);
  const total = inCar.reduce((s, p) => s + p.inCar / p.packSize, 0);
  useMainButton({ text: '🚚 Yuklash', onClick: () => nav.push('car-load', { mode: 'load' }) });
  return (
    <Page title="Mashina" subtitle={data ? `${Math.round(total * 10) / 10} blok` : undefined}>
      {!data ? (
        <SkeletonList />
      ) : inCar.length === 0 ? (
        <EmptyState icon="truck" title="Mashina bo'sh" text="Ertalab bugungi ro'yxat bo'yicha yuklang." />
      ) : (
        <List>
          {inCar.map((p) => (
            <Row key={p.productId} title={p.flavour} subtitle={`omborda: ${formatQty(p.warehouse, p.packSize)}`} right={<Qty cans={p.inCar} packSize={p.packSize} className="font-bold" />} />
          ))}
        </List>
      )}
      {inCar.length > 0 && (
        <Button block variant="secondary" icon="return" className="mt-4" onClick={() => nav.push('car-load', { mode: 'unload' })}>
          Tushirish (omborga)
        </Button>
      )}
    </Page>
  );
}

/** Morning loading (with the proposal) or unloading back to the warehouse. */
export function CarLoadScreen({ mode = 'load' }: { mode?: 'load' | 'unload' }) {
  const nav = useNav();
  const load = mode === 'load';
  const proposal = useApi<any>(load ? '/car/proposal' : null);
  const car = useApi<{ products: any[] }>('/car');
  const lines: any[] = load ? (proposal.data?.lines ?? []) : (car.data?.products ?? []).filter((p) => p.inCar > 0);
  const [packs, setPacks] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (load && proposal.data) setPacks(Object.fromEntries(proposal.data.lines.map((l: any) => [l.productId, l.proposedPacks])));
    if (!load && car.data) setPacks(Object.fromEntries(car.data.products.map((p: any) => [p.productId, Math.floor(p.inCar / p.packSize)])));
  }, [load, proposal.data, car.data]);
  const total = Object.values(packs).reduce((s, v) => s + v, 0);

  useMainButton({
    text: load ? `Yuklash · ${total} blok` : `Tushirish · ${total} blok`,
    disabled: !total,
    progress: busy,
    onClick: async () => {
      setBusy(true);
      try {
        const body = { lines: lines.map((l) => ({ productId: l.productId, qtyCans: (packs[l.productId] ?? 0) * l.packSize })).filter((l) => l.qtyCans > 0) };
        await api.post(load ? '/car/load' : '/car/unload', body);
        invalidate('/car', '/products', '/stock');
        toast(load ? 'Mashina yuklandi 🚚' : 'Omborga tushirildi ✅');
        nav.pop();
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });

  if (load ? !proposal.data : !car.data) return <Page title={load ? 'Yuklash' : 'Tushirish'}><Skeleton className="h-80" /></Page>;
  return (
    <Page title={load ? 'Yuklash' : 'Tushirish'} subtitle={load ? `Bugungi ${proposal.data.shops} ta do'kon uchun taklif (×${proposal.data.factor})` : 'Mashinadan omborga'}>
      <div className="space-y-2">
        {lines.map((l) => {
          const max = load ? Math.floor(l.warehouse / l.packSize) : Math.floor(l.inCar / l.packSize);
          return (
            <Card key={l.productId} className={cx('flex items-center gap-3', (packs[l.productId] ?? 0) > 0 && 'ring-2 ring-brand')}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{l.flavour}</div>
                <div className="text-[12.5px] text-muted">
                  {load ? (
                    <>
                      mashinada {formatQty(l.inCar, l.packSize)} · kutilgan {formatQty(l.expectedCans, l.packSize)}
                      {l.preorderCans ? ` · buyurtma ${formatQty(l.preorderCans, l.packSize)}` : ''}
                    </>
                  ) : (
                    <>mashinada {formatQty(l.inCar, l.packSize)}</>
                  )}
                </div>
                {load && l.short && <Badge tone="danger">omborda {formatQty(l.warehouse, l.packSize)}</Badge>}
              </div>
              <Stepper value={packs[l.productId] ?? 0} max={max} onChange={(v) => setPacks((p) => ({ ...p, [l.productId]: v }))} label="blok" />
            </Card>
          );
        })}
      </div>
    </Page>
  );
}
