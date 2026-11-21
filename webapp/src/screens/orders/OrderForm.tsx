import { useEffect, useMemo, useRef, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, Chip, Chips, Field, MoneyInput, Skeleton, Stepper, TextArea, TextInput, cx, ErrorBox } from '../../ui/kit';
import { Sheet } from '../../ui/sheet';
import { Icon } from '../../ui/icons';
import { api, ApiError, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { useIsOwner } from '../../session';
import { toast } from '../../ui/toast';
import { confirmDialog, haptic, supports } from '../../tg';
import { uid, dayLabel, addDays, localDate } from '../../util';
import { ShopPicker } from './ShopPicker';
import { ProductPhoto } from '../stock/StockTab';
import { formatMoney, percentOf } from '@shared/money';
import { formatQty, priceFor, splitCans } from '@shared/qty';
import { queueOrder } from '../../offline/queue';

interface FormProduct {
  id: number;
  name: string;
  flavour: string;
  packSize: number;
  photoUrl: string | null;
  perPack: number;
  perCan: number;
  minPerPack: number;
  minPerCan: number;
  available: number;
  favourite: boolean;
}

interface FormData {
  shop: { id: number; name: string; creditLimit: number | null; address: string | null };
  balance: { balance: number; overdue: number };
  deliveryDate: string;
  maxDiscountBp: number | null;
  products: FormProduct[];
  lastOrder: { id: number; number: string; date: string; lines: { productId: number; qtyCans: number; isBonus: boolean }[] } | null;
}

export interface Line {
  key: string;
  productId: number;
  qtyCans: number;
  isBonus: boolean;
  pricePerPack?: number;
  pricePerCan?: number;
}

type Mode = 'new' | 'edit' | 'revise';

/** New order (pick shop → products → confirm), edit before delivery, or revise after delivery. */
export function OrderForm({ shopId: initialShop, orderId, mode = 'new' }: { shopId?: number; orderId?: number; mode?: Mode }) {
  const nav = useNav();
  const [shopId, setShopId] = useState<number | undefined>(initialShop);
  const existing = useApi<any>(orderId ? `/orders/${orderId}` : null);
  const sid = shopId ?? existing.data?.order.shop.id;
  if (!sid) {
    if (orderId) return <Page title="Buyurtma"><Skeleton className="h-96" /></Page>;
    return <ShopPicker title="Yangi buyurtma" onPick={(id) => setShopId(id)} />;
  }
  return <OrderBuilder key={sid} shopId={sid} order={existing.data?.order} mode={mode} onDone={(id) => (id < 0 || mode !== 'new' ? nav.pop() : nav.replace('order', { id }))} />;
}

function OrderBuilder({ shopId, order, mode, onDone }: { shopId: number; order?: any; mode: Mode; onDone: (id: number) => void }) {
  const owner = useIsOwner();
  const { data, error, reload } = useApi<FormData>(`/order-form?shopId=${shopId}`);
  const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState<number | null>(null);
  const [deliveryDate, setDeliveryDate] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<'' | 'cart' | 'reason'>('');
  const [lineFor, setLineFor] = useState<FormProduct | null>(null);
  const [reason, setReason] = useState('');
  const idemKey = useRef(uid());

  // Prefill when editing
  useEffect(() => {
    if (!order) return;
    setLines(order.items.filter((i: any) => i.qtyCans > 0).map((i: any) => ({ key: uid(), productId: i.productId, qtyCans: i.qtyCans, isBonus: i.isBonus, pricePerPack: i.isBonus ? undefined : i.pricePerPack, pricePerCan: i.isBonus ? undefined : i.pricePerCan })));
    setDiscount(order.discount || null);
    setDeliveryDate(order.deliveryDate);
    setComment(order.comment ?? '');
  }, [order]);

  // A new order in progress is kept on the phone, so closing the app loses nothing
  const draftKey = `orderDraft:${shopId}`;
  useEffect(() => {
    if (mode !== 'new') return;
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
      if (saved?.lines?.length && Date.now() - saved.at < 3 * 86_400_000) {
        setLines(saved.lines);
        setDiscount(saved.discount ?? null);
        setComment(saved.comment ?? '');
        toast.info('Saqlangan qoralama tiklandi');
      }
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (mode !== 'new') return;
    try {
      if (lines.length) localStorage.setItem(draftKey, JSON.stringify({ lines, discount, comment, at: Date.now() }));
      else localStorage.removeItem(draftKey);
    } catch {
      /* storage unavailable */
    }
  }, [lines, discount, comment, mode, draftKey]);
  const clearDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  };

  const products = data?.products ?? [];
  const pmap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const priced = lines.map((l) => {
    const p = pmap.get(l.productId);
    const perPack = l.isBonus ? 0 : (l.pricePerPack ?? p?.perPack ?? 0);
    const perCan = l.isBonus ? 0 : (l.pricePerCan ?? p?.perCan ?? 0);
    return { ...l, perPack, perCan, packSize: p?.packSize ?? 24, total: l.isBonus ? 0 : priceFor(l.qtyCans, p?.packSize ?? 24, perPack, perCan) };
  });
  const subtotal = priced.reduce((s, l) => s + l.total, 0);
  const disc = Math.min(discount ?? 0, subtotal);
  const total = subtotal - disc;
  const packs = priced.reduce((s, l) => s + l.qtyCans / l.packSize, 0);
  const packsText = Number.isInteger(packs) ? String(packs) : packs.toFixed(1);
  const date = deliveryDate ?? data?.deliveryDate ?? localDate();

  const main = (pid: number) => lines.find((l) => l.productId === pid && !l.isBonus);
  const bonus = (pid: number) => lines.find((l) => l.productId === pid && l.isBonus);
  const setQty = (pid: number, qtyCans: number, isBonus = false) => {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.productId === pid && l.isBonus === isBonus);
      if (qtyCans <= 0) return i >= 0 ? ls.filter((_, k) => k !== i) : ls;
      if (i >= 0) return ls.map((l, k) => (k === i ? { ...l, qtyCans } : l));
      return [...ls, { key: uid(), productId: pid, qtyCans, isBonus }];
    });
  };

  const repeatLast = () => {
    if (!data?.lastOrder) return;
    haptic.success();
    setLines(data.lastOrder.lines.filter((l) => pmap.has(l.productId)).map((l) => ({ key: uid(), ...l })));
    toast(`Oxirgi buyurtma qo'yildi (${data.lastOrder.number})`);
  };

  const submit = async (force = false) => {
    if (!lines.length) return;
    if (mode === 'revise' && !reason.trim()) return setSheet('reason');
    setBusy(true);
    const payload = {
      lines: lines.map((l) => ({ productId: l.productId, qtyCans: l.qtyCans, isBonus: l.isBonus || undefined, pricePerPack: l.pricePerPack, pricePerCan: l.pricePerCan })),
      discount: disc || undefined,
      deliveryDate: date,
      comment: comment.trim() || null,
    };
    try {
      if (mode === 'revise') {
        await api.post(`/orders/${order.id}/revise`, { lines: payload.lines, discount: payload.discount, reason });
        toast('Tuzatildi ✅ Yangi yuk xati chatingizda');
        invalidate('/orders', '/shops', '/products');
        return onDone(order.id);
      }
      if (mode === 'edit') {
        await api.patch(`/orders/${order.id}`, { ...payload, force });
        toast('Saqlandi ✅');
        invalidate('/orders', '/shops', '/products');
        return onDone(order.id);
      }
      const r = await api.post('/orders', { shopId, ...payload, confirm: true, idempotencyKey: idemKey.current, force });
      clearDraft();
      invalidate('/orders', '/shops', '/products', '/today');
      if (r.confirmError) {
        haptic.warning();
        if (r.confirmError.code === 'credit_warning' && owner) {
          const yes = await confirmDialog(`${r.confirmError.message}\n\nBaribir tasdiqlaysizmi?`);
          if (yes) {
            await api.post(`/orders/${r.id}/confirm`, { force: true });
            invalidate('/orders', '/products');
            toast('Buyurtma tayyor ✅');
          } else toast.info('Qoralama sifatida saqlandi');
        } else toast(r.confirmError.message + ' — qoralama saqlandi', { tone: 'error' });
        return onDone(r.id);
      }
      toast('Buyurtma tayyor ✅');
      onDone(r.id);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'offline' && mode === 'new') {
        await queueOrder({ shopId, shopName: data?.shop.name ?? '', ...payload, confirm: true, idempotencyKey: idemKey.current });
        clearDraft();
        toast('Internet yo‘q — saqlandi, keyin yuboriladi');
        return onDone(-1);
      }
      if (err.code === 'credit_warning' && owner && !force) {
        if (await confirmDialog(`${err.message}\n\nBaribir saqlaysizmi?`)) return submit(true);
      } else toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  useMainButton({
    text: mode === 'revise' ? 'Tuzatishni saqlash' : mode === 'edit' ? 'Saqlash' : `Tasdiqlash · ${formatMoney(total)}`,
    disabled: !lines.length,
    progress: busy,
    onClick: () => submit(false),
  });

  if (error) return <Page title="Buyurtma"><ErrorBox error={error} onRetry={reload} /></Page>;
  if (!data) {
    return (
      <Page title="Buyurtma">
        <Skeleton className="h-16" />
        <div className="mt-3 grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[230px]" />)}
        </div>
      </Page>
    );
  }

  const title = mode === 'revise' ? 'Tuzatish' : mode === 'edit' ? 'Tahrirlash' : data.shop.name;
  return (
    <Page title={title} subtitle={mode === 'new' ? (data.balance.balance > 0 ? `Qarz: ${formatMoney(data.balance.balance)}` : data.shop.address ?? undefined) : data.shop.name}>
      {data.balance.overdue > 0 && (
        <Card className="mb-3 bg-danger-soft py-3 text-[14px] font-semibold text-danger shadow-none">⚠️ Muddati o'tgan qarz: {formatMoney(data.balance.overdue)}</Card>
      )}
      {mode === 'new' && data.lastOrder && (
        <Button block variant="soft" icon="repeat" size="md" onClick={repeatLast} className="mb-3">
          Takroriy buyurtma
        </Button>
      )}

      <div className="grid grid-cols-2 gap-3 pb-20">
        {products.map((p) => {
          const m = main(p.id);
          const b = bonus(p.id);
          const qty = m?.qtyCans ?? 0;
          const { packs, cans } = splitCans(qty, p.packSize);
          const price = m?.pricePerPack ?? p.perPack;
          return (
            <div key={p.id} className={cx('overflow-hidden rounded-[18px] bg-card shadow-card transition', qty > 0 && 'ring-2 ring-brand')}>
              <button className="relative block w-full text-left" onClick={() => setLineFor(p)}>
                <ProductPhoto p={p} className="h-[84px] w-full" />
                {p.favourite && <span className="absolute top-2 left-2 rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-accent-ink">★ odatiy</span>}
                {b && <span className="absolute top-2 right-2 rounded-full bg-ok px-2 py-0.5 text-[11px] font-bold text-white">+{formatQty(b.qtyCans, p.packSize)} 🎁</span>}
                <div className="px-3 pt-2">
                  <div className="truncate text-[16px] leading-tight font-bold">{p.flavour}</div>
                  <div className={cx('num text-[13.5px]', m?.pricePerPack != null && m.pricePerPack !== p.perPack ? 'font-semibold text-warn' : 'text-muted')}>{formatMoney(price)}</div>
                  <div className={cx('text-[12px]', p.available <= 0 ? 'text-danger' : 'text-muted')}>
                    {p.available > 0 ? `bor: ${formatQty(p.available, p.packSize)}` : 'omborda yo‘q'}
                  </div>
                </div>
              </button>
              <div className="flex items-center justify-center px-1 pt-1 pb-2.5">
                <Stepper
                  value={packs}
                  label={cans ? `+${cans} dona` : 'blok'}
                  onChange={(v) => setQty(p.id, v * p.packSize + cans)}
                  onLongPress={() => setLineFor(p)}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Sticky summary bar */}
      {lines.length > 0 && (
        <button
          onClick={() => setSheet('cart')}
          style={{ bottom: `calc(env(safe-area-inset-bottom) + ${supports.mainButton ? 12 : 76}px)` }}
          className="fixed inset-x-3 z-20 flex h-[60px] items-center gap-3 rounded-[18px] bg-[#10261b] px-4 text-white shadow-xl active:scale-[0.99]"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15">
            <Icon name="orders" size={20} />
          </span>
          <span className="num flex-1 text-left text-[17px] font-bold">
            {packsText} blok · {formatMoney(total)}
          </span>
          <span className="text-[13px] text-accent">{dayLabel(date)} ▸</span>
        </button>
      )}

      {lineFor && (
        <LineSheet
          p={lineFor}
          main={main(lineFor.id)}
          bonus={bonus(lineFor.id)}
          owner={owner}
          maxDiscountBp={data.maxDiscountBp}
          onClose={() => setLineFor(null)}
          onSave={(m, bq) => {
            setLines((ls) => {
              let next = ls.filter((l) => l.productId !== lineFor.id);
              if (m.qtyCans > 0) next = [...next, { key: uid(), productId: lineFor.id, isBonus: false, ...m }];
              if (bq > 0) next = [...next, { key: uid(), productId: lineFor.id, qtyCans: bq, isBonus: true }];
              return next;
            });
            setLineFor(null);
          }}
        />
      )}

      <Sheet
        open={sheet === 'cart'}
        onClose={() => setSheet('')}
        title="Buyurtma"
        footer={
          <Button block loading={busy} disabled={!lines.length} onClick={() => (setSheet(''), submit(false))}>
            {mode === 'new' ? `Tasdiqlash · ${formatMoney(total)}` : 'Saqlash'}
          </Button>
        }
      >
        <div className="divide-y divide-line overflow-hidden rounded-[18px] bg-card">
          {priced.map((l) => {
            const p = pmap.get(l.productId);
            return (
              <div key={l.key} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">
                    {p?.flavour} {l.isBonus && <Badge tone="ok">bonus</Badge>}
                  </div>
                  <div className="text-[13px] text-muted">
                    {formatQty(l.qtyCans, l.packSize)}
                    {!l.isBonus && ` × ${formatMoney(l.perPack)}`}
                  </div>
                </div>
                <div className="num text-right font-semibold">{l.isBonus ? '0' : formatMoney(l.total)}</div>
                <button aria-label="O'chirish" className="flex h-10 w-10 items-center justify-center text-muted" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Icon name="x" size={18} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-4 space-y-4">
          <Field label="Chegirma (butun buyurtma)" hint={data.maxDiscountBp != null ? `Eng ko'pi ${data.maxDiscountBp / 100}% (bonus ham hisoblanadi)` : undefined}>
            <MoneyInput value={discount} onChange={setDiscount} />
          </Field>
          {mode !== 'revise' && (
            <Field label="Yetkazish sanasi">
              <Chips>
                <Chip active={date === addDays(localDate(), 1)} onClick={() => setDeliveryDate(addDays(localDate(), 1))}>Ertaga</Chip>
                <Chip active={date === data.deliveryDate} onClick={() => setDeliveryDate(data.deliveryDate)}>
                  {dayLabel(data.deliveryDate) === 'Ertaga' ? 'Standart' : '2 kun'}
                </Chip>
                <Chip active={date === localDate()} onClick={() => setDeliveryDate(localDate())}>Bugun</Chip>
              </Chips>
              <TextInput type="date" className="mt-2" value={date} min={localDate()} onChange={(e) => setDeliveryDate(e.target.value)} />
            </Field>
          )}
          <Field label="Izoh (ixtiyoriy)">
            <TextArea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
          </Field>
          <Card className="bg-card2 shadow-none">
            <Total label="Jami" value={subtotal} />
            {disc > 0 && <Total label="Chegirma" value={-disc} />}
            <Total label="To'lov uchun" value={total} bold />
          </Card>
        </div>
      </Sheet>

      <Sheet
        open={sheet === 'reason'}
        onClose={() => setSheet('')}
        title="Tuzatish sababi"
        footer={
          <Button block disabled={reason.trim().length < 3} onClick={() => (setSheet(''), submit(false))}>
            Saqlash
          </Button>
        }
      >
        <TextArea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Masalan: 2 blok shikastlangan chiqdi" />
        <div className="mt-2 text-[13px] text-muted">Eski yuk xati «bekor qilingan versiya» bo'lib qoladi, yangi raqam: …-R1</div>
      </Sheet>
    </Page>
  );
}

function Total({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={cx('flex justify-between py-0.5', bold && 'text-[18px] font-bold')}>
      <span className={bold ? '' : 'text-muted'}>{label}</span>
      <span className="num">{formatMoney(value)}</span>
    </div>
  );
}

/** Per-flavour details: loose cans, own price (within limits), bonus. */
function LineSheet({
  p,
  main,
  bonus,
  owner,
  maxDiscountBp,
  onClose,
  onSave,
}: {
  p: FormProduct;
  main?: Line;
  bonus?: Line;
  owner: boolean;
  maxDiscountBp: number | null;
  onClose: () => void;
  onSave: (main: { qtyCans: number; pricePerPack?: number; pricePerCan?: number }, bonusCans: number) => void;
}) {
  const start = splitCans(main?.qtyCans ?? 0, p.packSize);
  const [packs, setPacks] = useState(start.packs);
  const [cans, setCans] = useState(start.cans);
  const [perPack, setPerPack] = useState<number | null>(main?.pricePerPack ?? p.perPack);
  const [perCan, setPerCan] = useState<number | null>(main?.pricePerCan ?? p.perCan);
  const [bonusPacks, setBonusPacks] = useState(Math.round((bonus?.qtyCans ?? 0) / p.packSize));
  const floorPack = maxDiscountBp != null ? Math.max(p.minPerPack, p.perPack - percentOf(p.perPack, maxDiscountBp)) : 0;
  const floorCan = maxDiscountBp != null ? Math.max(p.minPerCan, p.perCan - percentOf(p.perCan, maxDiscountBp)) : 0;
  const tooLow = !owner && ((perPack ?? 0) < floorPack || (perCan ?? 0) < floorCan);
  return (
    <Sheet
      open
      onClose={onClose}
      title={p.flavour}
      footer={
        <Button
          block
          disabled={tooLow}
          onClick={() =>
            onSave(
              {
                qtyCans: packs * p.packSize + cans,
                pricePerPack: perPack != null && perPack !== p.perPack ? perPack : undefined,
                pricePerCan: perCan != null && perCan !== p.perCan ? perCan : undefined,
              },
              bonusPacks * p.packSize,
            )
          }
        >
          Tayyor
        </Button>
      }
    >
      <div className="space-y-4">
        <Card className="flex items-center justify-around">
          <Stepper value={packs} onChange={setPacks} label="blok" />
          <Stepper value={cans} onChange={setCans} max={p.packSize - 1} label="dona" />
        </Card>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Blok narxi" error={!owner && (perPack ?? 0) < floorPack ? `≥ ${formatMoney(floorPack)}` : undefined}>
            <MoneyInput value={perPack} onChange={setPerPack} suffix="" />
          </Field>
          <Field label="Dona narxi" error={!owner && (perCan ?? 0) < floorCan ? `≥ ${formatMoney(floorCan)}` : undefined}>
            <MoneyInput value={perCan} onChange={setPerCan} suffix="" />
          </Field>
        </div>
        <Card className="flex items-center gap-3">
          <Icon name="gift" className="text-ok" />
          <div className="flex-1">
            <div className="font-semibold">Bonus (tekin)</div>
            <div className="text-[13px] text-muted">Masalan: 10 blokka 1 blok</div>
          </div>
          <Stepper value={bonusPacks} onChange={setBonusPacks} size="md" />
        </Card>
        <div className="text-center text-[15px]">
          Summa: <b className="num">{formatMoney(priceFor(packs * p.packSize + cans, p.packSize, perPack ?? 0, perCan ?? 0))}</b>
        </div>
      </div>
    </Sheet>
  );
}
