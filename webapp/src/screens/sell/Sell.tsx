import { useEffect, useMemo, useRef, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, Chip, Chips, ErrorBox, Field, MoneyInput, Segmented, Skeleton, Stepper, TextInput, cx } from '../../ui/kit';
import { Sheet } from '../../ui/sheet';
import { Icon } from '../../ui/icons';
import { api, ApiError, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { toast } from '../../ui/toast';
import { confirmDialog, haptic, supports } from '../../tg';
import { dayLabel, getPosition, localDate, uid } from '../../util';
import { ProductPhoto } from '../stock/StockTab';
import { LineSheet, type Line } from '../orders/OrderForm';
import { queueRequest } from '../../offline/queue';
import { markShopDone } from '../route/Drive';
import { formatMoney } from '@shared/money';
import { formatQty, priceFor, splitCans } from '@shared/qty';

interface SellProduct {
  id: number;
  name: string;
  flavour: string;
  packSize: number;
  photoUrl: string | null;
  perPack: number;
  perCan: number;
  minPerPack: number;
  minPerCan: number;
  inCar: number;
  lastQty: number;
}

const NO_ORDER_REASONS = ["Javon to'la", "Pul yo'q", "Egasi yo'q", 'Boshqa'];
type PayChoice = 'all' | 'half' | 'other' | 'none' | 'today';

/** "Sotish" at the shop: pick quantities from the car → payment for the old debt → done. */
export function SellScreen({ shopId, orderId }: { shopId: number; orderId?: number }) {
  const nav = useNav();
  const { data, error, reload } = useApi<any>(`/sell-form?shopId=${shopId}${orderId ? `&orderId=${orderId}` : ''}`);
  const [lines, setLines] = useState<Line[]>([]);
  const [mode, setMode] = useState<'now' | 'later'>('now');
  const [laterDate, setLaterDate] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'' | 'confirm' | 'noorder' | 'returns'>('');
  const [lineFor, setLineFor] = useState<SellProduct | null>(null);
  const [pay, setPay] = useState<PayChoice>('all');
  const [payOther, setPayOther] = useState<number | null>(null);
  const [method, setMethod] = useState<'CASH' | 'CARD' | 'TRANSFER'>('CASH');
  const [returns, setReturns] = useState<Record<number, { qty: number; condition: 'DAMAGED' | 'EXPIRED' | 'SELLABLE' }>>({});
  const [busy, setBusy] = useState(false);
  const key = useRef(uid());
  const pos = useRef<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    getPosition(6000).then((p) => (pos.current = p));
  }, []);

  // Pre-order to deliver: start from its lines
  useEffect(() => {
    if (data?.preorder) setLines(data.preorder.lines.map((l: any) => ({ key: uid(), ...l })));
    if (data && !data.balance?.balance) setPay('none');
  }, [data]);

  const products: SellProduct[] = data?.products ?? [];
  const pmap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const priced = lines.map((l) => {
    const p = pmap.get(l.productId);
    const perPack = l.isBonus ? 0 : (l.pricePerPack ?? p?.perPack ?? 0);
    const perCan = l.isBonus ? 0 : (l.pricePerCan ?? p?.perCan ?? 0);
    return { ...l, packSize: p?.packSize ?? 24, total: l.isBonus ? 0 : priceFor(l.qtyCans, p?.packSize ?? 24, perPack, perCan) };
  });
  const total = priced.reduce((s, l) => s + l.total, 0);
  const packs = priced.reduce((s, l) => s + l.qtyCans / l.packSize, 0);
  const debt = Math.max(0, data?.balance?.balance ?? 0);
  const payAmount = pay === 'all' ? debt : pay === 'half' ? Math.round(debt / 2 / 1000) * 1000 : pay === 'today' ? total + debt : pay === 'other' ? (payOther ?? 0) : 0;
  const blocked = (data?.warnings?.length ?? 0) > 0 && !data?.canOverride;
  const overCar = mode === 'now' && priced.some((l) => {
    const p = pmap.get(l.productId);
    const used = priced.filter((x) => x.productId === l.productId).reduce((s, x) => s + x.qtyCans, 0);
    return p && used > p.inCar;
  });

  const setQty = (pid: number, qtyCans: number) =>
    setLines((ls) => {
      const i = ls.findIndex((l) => l.productId === pid && !l.isBonus);
      if (qtyCans <= 0) return i >= 0 ? ls.filter((_, k) => k !== i) : ls;
      if (i >= 0) return ls.map((l, k) => (k === i ? { ...l, qtyCans } : l));
      return [...ls, { key: uid(), productId: pid, qtyCans, isBonus: false }];
    });

  const payload = () => ({
    shopId,
    lines: lines.map((l) => ({ productId: l.productId, qtyCans: l.qtyCans, isBonus: l.isBonus || undefined, pricePerPack: l.pricePerPack, pricePerCan: l.pricePerCan })),
    idempotencyKey: key.current,
    pos: pos.current,
  });

  const done = (msg: string) => {
    markShopDone(shopId);
    haptic.success();
    toast(msg);
    invalidate('/checklist', '/car', '/orders', '/shops', '/today', '/products', '/debtors');
    nav.pop();
  };

  const submit = async (force = false) => {
    if (blocked) return toast.error(data.warnings.join('. '));
    setBusy(true);
    const isLater = mode === 'later';
    const path = isLater ? '/sell/preorder' : '/sell';
    const body = isLater
      ? { ...payload(), deliveryDate: laterDate ?? data.preorderDate, force: force || undefined }
      : {
          ...payload(),
          orderId: data.preorder?.id ?? null,
          payment: payAmount > 0 ? { amount: payAmount, method } : null,
          returns: Object.entries(returns)
            .filter(([, r]) => r.qty > 0)
            .map(([pid, r]) => ({ productId: Number(pid), qtyCans: r.qty, condition: r.condition })),
          force: force || undefined,
        };
    try {
      const r = await api.post(path, body);
      if (r.confirmError) {
        toast(`${r.confirmError.message} — qoralama saqlandi`, { tone: 'error' });
        return nav.pop();
      }
      done(isLater ? `Buyurtma olindi ✅ ${dayLabel(r.deliveryDate)} yetkaziladi` : `Sotildi ✅ ${r.number}`);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'offline') {
        await queueRequest(isLater ? 'preorder' : 'sell', `${isLater ? 'Buyurtma' : 'Sotish'}: ${data.shop.name}`, path, body);
        return done("Internet yo'q — saqlandi, keyin yuboriladi");
      }
      if (err.code === 'credit_warning' && data.canOverride && !force) {
        if (await confirmDialog(`${err.message}\n\nBaribir davom etasizmi?`)) return submit(true);
      } else toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const noSale = async (kind: 'NO_ORDER' | 'CLOSED', reason: string) => {
    setBusy(true);
    const body = { shopId, kind, reason, payment: payAmount > 0 && kind === 'NO_ORDER' ? { amount: payAmount, method } : null, idempotencyKey: key.current, pos: pos.current };
    try {
      await api.post('/sell/no-order', body);
      done(kind === 'CLOSED' ? 'Belgilandi: yopiq edi' : "Belgilandi: buyurtma yo'q");
    } catch (e) {
      if ((e as ApiError).code === 'offline') {
        await queueRequest('nosale', `Tashrif: ${data.shop.name}`, '/sell/no-order', body);
        return done("Internet yo'q — saqlandi");
      }
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  useMainButton({
    text: mode === 'later' ? `Buyurtma · ${formatMoney(total)}` : `Sotish · ${formatMoney(total)}`,
    disabled: !lines.length || overCar || blocked,
    progress: busy,
    onClick: () => setSheet('confirm'),
  });

  if (error) return <Page title="Sotish"><ErrorBox error={error} onRetry={reload} /></Page>;
  if (!data) {
    return (
      <Page title="Sotish">
        <Skeleton className="h-24" />
        <div className="mt-3 grid grid-cols-2 gap-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[220px]" />)}</div>
      </Page>
    );
  }

  return (
    <Page title={data.shop.name} subtitle={data.preorder ? `Yetkazish: ${data.preorder.number}` : data.shop.address ?? undefined}>
      {data.warnings.length > 0 && (
        <Card className="mb-3 bg-danger-soft py-3 text-[14px] font-semibold text-danger shadow-none">
          ⚠️ {data.warnings.join('. ')}
          {!data.canOverride && <div className="mt-1 font-normal">Sotish uchun egasi bilan gaplashing.</div>}
        </Card>
      )}
      {debt > 0 && (
        <Card className="mb-3 flex items-center gap-3 py-3">
          <Icon name="wallet" className="text-brand" />
          <div className="flex-1">
            <div className="text-[13px] text-muted">Oldingi qarz</div>
            <div className="num text-[18px] font-bold">{formatMoney(debt)}</div>
          </div>
          {data.balance.overdue > 0 && <Badge tone="danger">muddati o'tgan</Badge>}
        </Card>
      )}

      {!data.preorder && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <Button size="md" variant="secondary" onClick={() => setSheet('noorder')}>🚫 Buyurtma yo'q</Button>
          <Button size="md" variant="secondary" loading={busy} onClick={() => noSale('CLOSED', 'Yopiq edi')}>🔒 Yopiq edi</Button>
        </div>
      )}

      {!data.preorder && (
        <div className="mb-3">
          <Segmented value={mode} onChange={setMode} options={[{ value: 'now', label: 'Hozir sotish' }, { value: 'later', label: 'Keyinroq yetkazish' }]} />
          {mode === 'later' && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[14px] text-muted">Yetkazish:</span>
              <TextInput type="date" value={laterDate ?? data.preorderDate} min={localDate()} onChange={(e) => setLaterDate(e.target.value)} />
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 pb-20">
        {products.map((p) => {
          const m = lines.find((l) => l.productId === p.id && !l.isBonus);
          const b = lines.find((l) => l.productId === p.id && l.isBonus);
          const qty = m?.qtyCans ?? 0;
          const { packs, cans } = splitCans(qty, p.packSize);
          const carPacks = Math.floor(p.inCar / p.packSize);
          const short = mode === 'now' && qty + (b?.qtyCans ?? 0) > p.inCar;
          return (
            <div key={p.id} className={cx('overflow-hidden rounded-[18px] bg-card shadow-card', qty > 0 && 'ring-2 ring-brand', short && 'ring-2 ring-danger')}>
              <button className="relative block w-full text-left" onClick={() => setLineFor(p)}>
                <ProductPhoto p={p} className="h-[78px] w-full" />
                {p.lastQty > 0 && <span className="absolute top-2 left-2 rounded-full bg-accent px-2 py-0.5 text-[11px] font-bold text-accent-ink">oldin {formatQty(p.lastQty, p.packSize)}</span>}
                {b && <span className="absolute top-2 right-2 rounded-full bg-ok px-2 py-0.5 text-[11px] font-bold text-white">+{formatQty(b.qtyCans, p.packSize)} 🎁</span>}
                <div className="px-3 pt-2">
                  <div className="truncate text-[16px] leading-tight font-bold">{p.flavour}</div>
                  <div className={cx('num text-[13px]', m?.pricePerPack != null && m.pricePerPack !== p.perPack ? 'font-semibold text-warn' : 'text-muted')}>{formatMoney(m?.pricePerPack ?? p.perPack)}</div>
                  {mode === 'now' && <div className={cx('text-[12px] font-semibold', short || p.inCar === 0 ? 'text-danger' : 'text-ok')}>{short ? `Mashinada ${formatQty(p.inCar, p.packSize)} bor` : `mashinada ${formatQty(p.inCar, p.packSize)}`}</div>}
                </div>
              </button>
              <div className="flex items-center justify-center px-1 pt-1 pb-2.5">
                <Stepper value={packs} max={mode === 'now' ? Math.max(carPacks, packs) : 9999} label={cans ? `+${cans} dona` : 'blok'} onChange={(v) => setQty(p.id, v * p.packSize + cans)} onLongPress={() => setLineFor(p)} />
              </div>
            </div>
          );
        })}
      </div>

      {lines.length > 0 && (
        <button
          onClick={() => setSheet('confirm')}
          style={{ bottom: `calc(env(safe-area-inset-bottom) + ${supports.mainButton ? 12 : 76}px)` }}
          className="fixed inset-x-3 z-20 flex h-[60px] items-center gap-3 rounded-[18px] bg-[#10261b] px-4 text-white shadow-xl active:scale-[0.99]"
        >
          <span className="num flex-1 text-left text-[17px] font-bold">
            {Number.isInteger(packs) ? packs : packs.toFixed(1)} blok · {formatMoney(total)}
          </span>
          <span className="text-[13px] text-accent">{overCar ? 'mashinada yetmaydi' : 'tasdiqlash ▸'}</span>
        </button>
      )}

      {lineFor && (
        <LineSheet
          p={{ ...lineFor, available: lineFor.inCar, favourite: false }}
          main={lines.find((l) => l.productId === lineFor.id && !l.isBonus)}
          bonus={lines.find((l) => l.productId === lineFor.id && l.isBonus)}
          owner={data.canOverride}
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

      {/* Confirm: payment for the old debt, returns, final total */}
      <Sheet
        open={sheet === 'confirm'}
        onClose={() => setSheet('')}
        title={mode === 'later' ? 'Buyurtmani tasdiqlash' : 'Sotishni tasdiqlash'}
        footer={
          <Button block loading={busy} disabled={!lines.length || overCar || blocked} onClick={() => (setSheet(''), submit())}>
            {mode === 'later' ? `Buyurtma · ${formatMoney(total)}` : `Sotish · ${formatMoney(total)}`}
          </Button>
        }
      >
        <Card className="bg-card2 shadow-none">
          <div className="flex justify-between">
            <span className="text-muted">Bugungi tovar</span>
            <span className="num font-bold">{formatMoney(total)}</span>
          </div>
          {mode === 'now' && debt > 0 && (
            <div className="flex justify-between">
              <span className="text-muted">Oldingi qarz</span>
              <span className="num">{formatMoney(debt)}</span>
            </div>
          )}
        </Card>
        {mode === 'now' && (
          <>
            <Field label={debt > 0 ? `Oldingi qarz: ${formatMoney(debt)} — qancha oldingiz?` : 'Pul oldingizmi?'}>
              <Chips>
                {debt > 0 && <Chip active={pay === 'all'} onClick={() => setPay('all')}>Hammasi</Chip>}
                {debt > 0 && <Chip active={pay === 'half'} onClick={() => setPay('half')}>Yarmi</Chip>}
                <Chip active={pay === 'today'} onClick={() => setPay('today')}>{debt > 0 ? 'Qarz + bugungi' : "Bugungisini to'ladi"}</Chip>
                <Chip active={pay === 'other'} onClick={() => setPay('other')}>Boshqa</Chip>
                <Chip active={pay === 'none'} onClick={() => setPay('none')}>Hech narsa</Chip>
              </Chips>
            </Field>
            {pay === 'other' && <MoneyInput value={payOther} onChange={setPayOther} autoFocus />}
            {payAmount > 0 && (
              <div className="mt-2 space-y-2">
                <div className="text-center text-[15px]">
                  Olinadi: <b className="num">{formatMoney(payAmount)}</b>
                </div>
                <Segmented value={method} onChange={setMethod} options={[{ value: 'CASH', label: 'Naqd' }, { value: 'CARD', label: 'Karta' }, { value: 'TRANSFER', label: "O'tkazma" }]} />
              </div>
            )}
            <Button block variant="ghost" icon="return" className="mt-3" onClick={() => setSheet('returns')}>
              Qaytarish (shikastlangan bankalar){Object.values(returns).some((r) => r.qty > 0) ? ' ✓' : ''}
            </Button>
          </>
        )}
        <div className="mt-3 text-center text-[13px] text-muted">Yuk xati chatingizga keladi — do'konga ulashishingiz mumkin.</div>
      </Sheet>

      <Sheet open={sheet === 'noorder'} onClose={() => setSheet('')} title="Buyurtma yo'q — sabab">
        <div className="flex flex-wrap gap-2">
          {NO_ORDER_REASONS.map((r) => (
            <Button key={r} size="md" variant="secondary" loading={busy} onClick={() => (setSheet(''), noSale('NO_ORDER', r))}>
              {r}
            </Button>
          ))}
        </div>
        {debt > 0 && <div className="mt-3 text-[13px] text-muted">Qarz to'lansa, avval «Sotishni tasdiqlash» oynasida summani tanlang.</div>}
      </Sheet>

      <Sheet open={sheet === 'returns'} onClose={() => setSheet('confirm')} title="Qaytarish" footer={<Button block onClick={() => setSheet('confirm')}>Tayyor</Button>}>
        <div className="space-y-2">
          {products.map((p) => {
            const r = returns[p.id] ?? { qty: 0, condition: 'DAMAGED' as const };
            const { packs: rp, cans: rc } = splitCans(r.qty, p.packSize);
            return (
              <Card key={p.id} className={cx(r.qty > 0 && 'ring-2 ring-warn')}>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1 truncate font-bold">{p.flavour}</div>
                  <Stepper size="md" value={rp} label="blok" onChange={(v) => setReturns((x) => ({ ...x, [p.id]: { ...r, qty: v * p.packSize + rc } }))} />
                  <Stepper size="md" value={rc} max={p.packSize - 1} label="dona" onChange={(v) => setReturns((x) => ({ ...x, [p.id]: { ...r, qty: rp * p.packSize + v } }))} />
                </div>
                {r.qty > 0 && (
                  <Chips className="mt-2">
                    {(['DAMAGED', 'EXPIRED', 'SELLABLE'] as const).map((c) => (
                      <Chip key={c} active={r.condition === c} onClick={() => setReturns((x) => ({ ...x, [p.id]: { ...r, condition: c } }))}>
                        {c === 'DAMAGED' ? 'Shikastlangan' : c === 'EXPIRED' ? "Muddati o'tgan" : 'Sotsa bo‘ladi'}
                      </Chip>
                    ))}
                  </Chips>
                )}
              </Card>
            );
          })}
        </div>
      </Sheet>
    </Page>
  );
}
