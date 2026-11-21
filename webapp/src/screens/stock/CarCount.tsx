import { useEffect, useState } from 'react';
import { Card, Section, Stepper, cx } from '../../ui/kit';
import { api, useApi } from '../../api';
import { formatQty, splitCans } from '@shared/qty';

// Evening car stock count for "Kun yakuni": what is really left in the car.

export interface CarCount {
  products: { productId: number; flavour: string; packSize: number; inCar: number }[];
  counted: Record<number, number>;
  setCounted: (pid: number, cans: number) => void;
  hasDiff: boolean;
  diffText: string;
  save: () => Promise<void>;
}

export function useCarCount(): CarCount {
  const { data } = useApi<{ products: any[] }>('/car');
  const [counted, setAll] = useState<Record<number, number>>({});
  useEffect(() => {
    if (data) setAll(Object.fromEntries(data.products.map((p) => [p.productId, p.inCar])));
  }, [data]);
  const products = (data?.products ?? []).filter((p) => p.inCar > 0 || (counted[p.productId] ?? 0) > 0);
  const diffs = products.filter((p) => (counted[p.productId] ?? p.inCar) !== p.inCar);
  return {
    products,
    counted,
    setCounted: (pid, cans) => setAll((c) => ({ ...c, [pid]: cans })),
    hasDiff: diffs.length > 0,
    diffText: diffs.map((p) => `${p.flavour} ${(counted[p.productId] ?? 0) - p.inCar > 0 ? '+' : ''}${formatQty((counted[p.productId] ?? 0) - p.inCar, p.packSize)}`).join(', '),
    save: async () => {
      if (!products.length) return;
      await api.post('/car/count', { items: products.map((p) => ({ productId: p.productId, countedCans: counted[p.productId] ?? p.inCar })) });
    },
  };
}

export function CarCountSection({ car }: { car: CarCount }) {
  if (!car.products.length) return null;
  return (
    <Section title="Mashinada qancha qoldi? (sanab chiqing)">
      <div className="space-y-2">
        {car.products.map((p) => {
          const c = car.counted[p.productId] ?? p.inCar;
          const { packs, cans } = splitCans(c, p.packSize);
          const diff = c - p.inCar;
          return (
            <Card key={p.productId} className={cx('flex items-center gap-2', diff !== 0 && 'ring-2 ring-warn')}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{p.flavour}</div>
                <div className="text-[12.5px] text-muted">hisobda: {formatQty(p.inCar, p.packSize)}</div>
                {diff !== 0 && <div className={cx('text-[13px] font-semibold', diff < 0 ? 'text-danger' : 'text-ok')}>{diff < 0 ? 'Kam: ' : 'Ortiqcha: +'}{formatQty(Math.abs(diff), p.packSize)}</div>}
              </div>
              <Stepper size="md" value={packs} label="blok" onChange={(v) => car.setCounted(p.productId, v * p.packSize + cans)} />
              <Stepper size="md" value={cans} max={p.packSize - 1} label="dona" onChange={(v) => car.setCounted(p.productId, packs * p.packSize + v)} />
            </Card>
          );
        })}
      </div>
    </Section>
  );
}
