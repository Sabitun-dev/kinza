import { useEffect, useState } from 'react';
import { Page } from '../../ui/page';
import { Card, Chip, Chips, Field, MoneyInput, Section, Segmented, Skeleton, Stepper, cx } from '../../ui/kit';
import { PhotoPicker } from '../../ui/photo';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { useRole } from '../../session';
import { toast } from '../../ui/toast';
import { formatMoney } from '@shared/money';
import { priceFor, splitCans } from '@shared/qty';

/** "Yetkazildi": actual quantities (the shop may take less), signed nakladnoy photo, cash now. */
export function DeliverScreen({ id }: { id: number }) {
  const nav = useNav();
  const role = useRole();
  const { data } = useApi<{ order: any }>(`/orders/${id}`);
  const o = data?.order;
  const [qty, setQty] = useState<Record<number, number>>({});
  const [photo, setPhoto] = useState<{ id: number; url: string } | null>(null);
  const [cash, setCash] = useState<number | null>(null);
  const [method, setMethod] = useState<'CASH' | 'CARD' | 'TRANSFER'>('CASH');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (o) setQty(Object.fromEntries(o.items.map((i: any) => [i.id, i.qtyCans])));
  }, [o]);

  // Driver does not see prices: the server sends only the total to collect
  const total = o
    ? o.items[0]?.pricePerPack !== undefined
      ? Math.max(0, o.items.reduce((s: number, i: any) => s + (i.isBonus ? 0 : priceFor(qty[i.id] ?? i.qtyCans, i.packSize, i.pricePerPack, i.pricePerCan)), 0) - (o.discount ?? 0))
      : o.total
    : 0;
  const changed = o?.items.some((i: any) => qty[i.id] !== i.qtyCans);

  useMainButton({
    text: cash ? `Yetkazildi · ${formatMoney(cash)} oldim` : 'Yetkazildi',
    progress: busy,
    disabled: !o,
    onClick: async () => {
      setBusy(true);
      try {
        const r = await api.post(`/orders/${id}/deliver`, {
          items: o.items.map((i: any) => ({ id: i.id, qtyCans: qty[i.id] ?? i.qtyCans })),
          photoFileId: photo?.id ?? null,
          payment: cash ? { amount: cash, method } : null,
        });
        toast(`Yetkazildi ✅ ${r.waybillNumber} chatingizda`);
        invalidate('/orders', '/shops', '/products', '/today', '/payments', '/cash');
        nav.pop();
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });

  if (!o) return <Page title="Yetkazish"><Skeleton className="h-96" /></Page>;

  return (
    <Page title="Yetkazish" subtitle={`${o.shop.name} · ${o.number}`}>
      <Section title="Do'kon qancha oldi?" className="mt-1">
        <div className="space-y-2">
          {o.items.map((i: any) => {
            const cur = qty[i.id] ?? i.qtyCans;
            const { packs, cans } = splitCans(cur, i.packSize);
            const less = cur < i.qtyCans;
            return (
              <Card key={i.id} className={cx('flex items-center gap-3', less && 'ring-2 ring-warn')}>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">
                    {i.flavour} {i.isBonus && '🎁'}
                  </div>
                  <div className="text-[13px] text-muted">buyurtma: {Math.floor(i.qtyCans / i.packSize)} blok{i.qtyCans % i.packSize ? ` + ${i.qtyCans % i.packSize} dona` : ''}</div>
                </div>
                <Stepper value={packs} max={Math.floor(i.qtyCans / i.packSize)} label={cans ? `+${cans} dona` : 'blok'} onChange={(v) => setQty((q) => ({ ...q, [i.id]: Math.min(i.qtyCans, v * i.packSize + cans) }))} />
              </Card>
            );
          })}
        </div>
      </Section>

      <Card className="mt-4 bg-brand text-brand-ink">
        <div className="text-[14px] opacity-80">{changed ? 'Yangi summa' : 'Olinadigan summa'}</div>
        <div className="num text-[30px] font-bold">{formatMoney(total)}</div>
      </Card>

      <Section title="Pul oldingizmi?">
        <Chips>
          <Chip active={cash === total} onClick={() => setCash(total)}>To'liq</Chip>
          <Chip active={!cash} onClick={() => setCash(null)}>Keyin to'laydi</Chip>
        </Chips>
        <div className="mt-2">
          <MoneyInput value={cash} onChange={setCash} placeholder="Qancha oldingiz" />
        </div>
        {cash ? (
          <div className="mt-2">
            <Segmented value={method} onChange={setMethod} options={[{ value: 'CASH', label: 'Naqd' }, { value: 'CARD', label: 'Karta' }, { value: 'TRANSFER', label: "O'tkazma" }]} />
          </div>
        ) : null}
        {role !== 'OWNER' && cash ? <div className="mt-2 text-[13px] text-muted">Pul egasiga topshirilguncha «sizning qo'lingizda» turadi.</div> : null}
      </Section>

      <Section title="Imzolangan yuk xati rasmi">
        <Field label="">
          <PhotoPicker kind="DELIVERY_PHOTO" url={photo?.url} label="Rasmga olish" className="h-36 w-full" onUploaded={setPhoto} />
        </Field>
      </Section>
    </Page>
  );
}
