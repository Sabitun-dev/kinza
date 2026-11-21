import { useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, ErrorBox, Field, IconButton, List, Money, MoneyInput, Qty, Row, Section, Skeleton, StatusBadge, TextInput, cx } from '../../ui/kit';
import { Sheet, ChoiceSheet } from '../../ui/sheet';
import { Icon, type IconName } from '../../ui/icons';
import { api, invalidate, useApi } from '../../api';
import { useNav } from '../../nav';
import { useIsOwner } from '../../session';
import { toast } from '../../ui/toast';
import { ago, callPhone, daysAgo, formatDate, openMaps, localDate } from '../../util';
import { confirmDialog, haptic } from '../../tg';
import { t } from '@shared/i18n';
import { formatMoney } from '@shared/money';
import { WEEKDAYS_UZ } from '@shared/dates';
import { DocumentList } from '../orders/DocumentList';

export function ShopDetail({ id }: { id: number }) {
  const nav = useNav();
  const owner = useIsOwner();
  const { data, error, reload } = useApi<any>(`/shops/${id}`);
  const [sheet, setSheet] = useState<'' | 'prices' | 'opening' | 'map' | 'phones'>('');

  if (error) return <Page title="Do'kon"><ErrorBox error={error} onRetry={reload} /></Page>;
  if (!data) {
    return (
      <Page title="Do'kon">
        <Skeleton className="h-40" />
        <Skeleton className="mt-3 h-20" />
        <Skeleton className="mt-3 h-64" />
      </Page>
    );
  }
  const { shop, balance, stats, orders, payments, specialPrices, documents, creditLeft } = data;
  const age = daysAgo(balance.oldestUnpaid);
  const call = () => {
    if (!shop.phones.length) return toast.error("Telefon raqam yo'q");
    if (shop.phones.length === 1) callPhone(shop.phones[0]);
    else setSheet('phones');
  };

  const actions: { icon: IconName; label: string; onClick: () => void; primary?: boolean }[] = [
    { icon: 'orders', label: 'Buyurtma', onClick: () => nav.push('order-new', { shopId: id }), primary: true },
    { icon: 'wallet', label: "To'lov", onClick: () => nav.push('payment-new', { shopId: id }) },
    { icon: 'pin', label: 'Tashrif', onClick: () => nav.push('visit-new', { shopId: id }) },
    { icon: 'phone', label: "Qo'ng'iroq", onClick: call },
    { icon: 'nav', label: 'Xarita', onClick: () => (shop.lat ? setSheet('map') : toast.error("Joylashuv saqlanmagan")) },
  ];

  return (
    <Page
      title={shop.name}
      subtitle={[shop.contactName, shop.district?.name].filter(Boolean).join(' · ')}
      right={<IconButton icon="edit" label="Tahrirlash" onClick={() => nav.push('shop-edit', { id })} />}
    >
      <div className="flex items-center gap-2">
        <StatusBadge kind="shop" status={shop.status} />
        {shop.archivedAt && <Badge tone="danger">arxivda</Badge>}
        {shop.priceGroup && <Badge tone="brand">{shop.priceGroup.name}</Badge>}
      </div>

      {/* Balance */}
      <Card className={cx('mt-3', balance.overdue > 0 ? 'bg-danger-soft' : balance.balance > 0 ? '' : 'bg-ok-soft')}>
        <div className="text-[14px] font-medium text-muted">{balance.balance >= 0 ? 'Qarz' : 'Do‘kon foydasiga (avans)'}</div>
        <div className={cx('num mt-0.5 text-[30px] leading-tight font-bold', balance.overdue > 0 ? 'text-danger' : balance.balance > 0 ? 'text-text' : 'text-ok')}>
          {formatMoney(Math.abs(balance.balance))}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[14px]">
          {balance.overdue > 0 && <span className="font-semibold text-danger">⚠️ Muddati o'tgan: {formatMoney(balance.overdue)}</span>}
          {age != null && balance.balance > 0 && <span className="text-muted">eng eski qarz: {age} kun</span>}
          {creditLeft != null && <span className={creditLeft < 0 ? 'font-semibold text-danger' : 'text-muted'}>limit qoldig'i: {formatMoney(creditLeft)}</span>}
        </div>
      </Card>

      {/* Quick actions */}
      <div className="mt-3 grid grid-cols-5 gap-2">
        {actions.map((a) => (
          <button
            key={a.label}
            onClick={() => {
              haptic.tap();
              a.onClick();
            }}
            className="flex flex-col items-center gap-1.5 active:scale-95"
          >
            <span className={cx('flex h-14 w-14 items-center justify-center rounded-[18px]', a.primary ? 'bg-brand text-brand-ink' : 'bg-card text-brand shadow-card')}>
              <Icon name={a.icon} size={24} />
            </span>
            <span className="text-[12px] font-semibold">{a.label}</span>
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <MiniStat label="Jami olgan" value={formatMoney(stats.totalBought)} sub={`${stats.orderCount} ta buyurtma`} />
        <MiniStat label="O'rtacha buyurtma" value={formatMoney(stats.avgOrder)} />
        <MiniStat label="Oxirgi buyurtma" value={ago(stats.lastOrderAt)} />
        <MiniStat label="Oxirgi tashrif" value={stats.lastVisit ? ago(stats.lastVisit.at) : '—'} sub={stats.lastVisit ? t(`visitResult.${stats.lastVisit.result}` as never) : undefined} />
      </div>
      {stats.nextDelivery && (
        <Card className="mt-3" onClick={() => nav.push('order', { id: stats.nextDelivery.id })}>
          <div className="flex items-center gap-3">
            <Icon name="truck" className="text-brand" />
            <div className="flex-1">
              <div className="font-semibold">Keyingi yetkazish: {formatDate(stats.nextDelivery.date)}</div>
              <div className="text-[13px] text-muted">{stats.nextDelivery.number}</div>
            </div>
            <Icon name="chevron" className="text-muted" size={18} />
          </div>
        </Card>
      )}
      {stats.favourites.length > 0 && (
        <Section title="Sevimli ta'mlar">
          <div className="flex flex-wrap gap-2">
            {stats.favourites.map((f: any) => (
              <span key={f.productId} className="rounded-full bg-brand-soft px-3 py-1.5 text-[14px] font-semibold text-brand">
                {f.flavour} · <Qty cans={f.cans} packSize={f.packSize} />
              </span>
            ))}
          </div>
        </Section>
      )}

      {shop.notes && (
        <Section title="Izoh">
          <Card className="text-[15px] whitespace-pre-wrap">{shop.notes}</Card>
        </Section>
      )}

      <Section title="Buyurtmalar">
        {orders.length === 0 ? (
          <Card className="text-center text-muted">Hali buyurtma yo'q</Card>
        ) : (
          <List>
            {orders.map((o: any) => (
              <Row
                key={o.id}
                title={o.isOpening ? "Boshlang'ich qarz" : o.number}
                subtitle={formatDate(o.deliveryDate)}
                right={
                  <div className="flex flex-col items-end gap-1">
                    <Money value={o.total} className="font-semibold" />
                    {o.payStatus ? <StatusBadge kind="pay" status={o.payStatus} small /> : <StatusBadge kind="order" status={o.status} small />}
                  </div>
                }
                onClick={o.isOpening ? undefined : () => nav.push('order', { id: o.id })}
              />
            ))}
          </List>
        )}
      </Section>

      {payments.length > 0 && (
        <Section title="To'lovlar">
          <List>
            {payments.map((p: any) => (
              <Row key={p.id} title={<Money value={p.amount} className="text-ok" sign />} subtitle={`${formatDate(localDate(new Date(p.paidAt)))} · ${t(`payMethod.${p.method}` as never)} · ${p.receivedBy}`} />
            ))}
          </List>
        </Section>
      )}

      {documents.length > 0 && (
        <Section title="Hujjatlar">
          <DocumentList docs={documents} />
        </Section>
      )}

      <Section title="Ma'lumot">
        <List>
          {shop.phones.map((p: string) => (
            <Row key={p} title={p} subtitle="Telefon" onClick={() => callPhone(p)} right={<Icon name="phone" className="text-brand" />} chevron={false} />
          ))}
          {shop.address && <Row title={shop.address} subtitle="Manzil" />}
          {shop.district && <Row title={shop.district.name} subtitle={shop.district.routeDay ? `Marshrut: ${WEEKDAYS_UZ[shop.district.routeDay]}` : 'Hudud'} />}
          <Row title={`${shop.paymentDaysEffective} kun`} subtitle="To'lov muddati" />
          {shop.creditLimit != null && <Row title={formatMoney(shop.creditLimit)} subtitle="Kredit limiti" />}
          {shop.agent && <Row title={shop.agent.name} subtitle="Agent" />}
          {shop.stir && <Row title={`${shop.legalName ?? ''} · STIR ${shop.stir}`} subtitle="Rekvizitlar" />}
        </List>
      </Section>

      {owner && (
        <Section title="Egasi uchun">
          <List>
            <Row title="Maxsus narxlar" subtitle={specialPrices.length ? `${specialPrices.length} ta mahsulot` : "Yo'q — guruh narxi ishlaydi"} onClick={() => setSheet('prices')} />
            <Row title="Boshlang'ich qarz kiritish" subtitle="Ilovadan oldingi qarz" onClick={() => setSheet('opening')} />
            <Row title="Solishtirma dalolatnoma (akt sverki)" onClick={() => nav.push('reconciliation', { shopId: id })} />
            <Row
              title={shop.archivedAt ? 'Arxivdan chiqarish' : 'Arxivlash'}
              onClick={async () => {
                if (!shop.archivedAt && !(await confirmDialog("Do'konni arxivlaysizmi? Ma'lumotlari saqlanadi."))) return;
                await api.post(`/shops/${id}/archive`, { archived: !shop.archivedAt });
                invalidate('/shops');
                toast(t('common.done'));
              }}
            />
          </List>
        </Section>
      )}

      {sheet === 'prices' && <SpecialPricesSheet shopId={id} current={specialPrices} onClose={() => setSheet('')} />}
      {sheet === 'opening' && <OpeningSheet shopId={id} onClose={() => setSheet('')} />}
      <ChoiceSheet
        open={sheet === 'map'}
        onClose={() => setSheet('')}
        title="Xaritada ochish"
        options={[
          { value: 'yandex', label: 'Yandex Xaritalar' },
          { value: 'google', label: 'Google Maps' },
        ]}
        onPick={(v) => openMaps(shop.lat, shop.lng, v as 'yandex' | 'google')}
      />
      <ChoiceSheet open={sheet === 'phones'} onClose={() => setSheet('')} title="Qaysi raqamga?" options={shop.phones.map((p: string) => ({ value: p, label: p }))} onPick={(p) => callPhone(String(p))} />
    </Page>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <div className="text-[13px] text-muted">{label}</div>
      <div className="num mt-0.5 truncate text-[17px] font-bold">{value}</div>
      {sub && <div className="truncate text-[12px] text-muted">{sub}</div>}
    </Card>
  );
}

function SpecialPricesSheet({ shopId, current, onClose }: { shopId: number; current: any[]; onClose: () => void }) {
  const products = useApi<{ products: any[] }>('/products');
  const [values, setValues] = useState<Record<number, number | null>>(() => Object.fromEntries(current.map((c) => [c.productId, c.perPack])));
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open
      tall
      onClose={onClose}
      title="Maxsus narxlar (blok)"
      footer={
        <Button
          block
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const prices = (products.data?.products ?? []).map((p) => ({ productId: p.id, perPack: values[p.id] ?? null }));
              await api.put(`/shops/${shopId}/prices`, { prices });
              invalidate(`/shops/${shopId}`, '/pricing');
              toast(t('common.saved'));
              onClose();
            } catch (e) {
              toast.error(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('common.save')}
        </Button>
      }
    >
      <div className="mb-3 text-[14px] text-muted">Bo'sh qoldirilsa — guruh yoki asosiy narx ishlaydi.</div>
      <div className="space-y-3">
        {(products.data?.products ?? []).map((p) => (
          <Field key={p.id} label={`${p.flavour} · asosiy ${formatMoney(p.prices?.perPack ?? 0)}`}>
            <MoneyInput value={values[p.id] ?? null} onChange={(v) => setValues((x) => ({ ...x, [p.id]: v }))} placeholder="—" />
          </Field>
        ))}
      </div>
    </Sheet>
  );
}

function OpeningSheet({ shopId, onClose }: { shopId: number; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(localDate());
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Boshlang'ich qarz"
      footer={
        <Button
          block
          disabled={!amount}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post(`/shops/${shopId}/opening-balance`, { amount, date });
              invalidate('/shops');
              toast(t('common.saved'));
              onClose();
            } catch (e) {
              toast.error(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('common.save')}
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Summa">
          <MoneyInput value={amount} onChange={setAmount} autoFocus />
        </Field>
        <Field label="Qachondan beri">
          <TextInput type="date" value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}
