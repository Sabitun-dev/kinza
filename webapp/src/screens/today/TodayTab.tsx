import { Page } from '../../ui/page';
import { Badge, Button, Card, ErrorBox, List, Money, Row, Section, Skeleton, Stat, StatusBadge, cx } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { api, invalidate, useApi } from '../../api';
import { useNav } from '../../nav';
import { useSession } from '../../session';
import { toast } from '../../ui/toast';
import { dayLabel, localDate } from '../../util';
import { formatDateHuman, WEEKDAYS_UZ, weekday } from '@shared/dates';
import { formatMoney } from '@shared/money';
import { formatQty } from '@shared/qty';

export function TodayTab() {
  const nav = useNav();
  const { user } = useSession();
  const { data, error, reload } = useApi<any>('/today');
  const today = localDate();
  const owner = user.role === 'OWNER';
  const driver = user.role === 'DRIVER';
  const pending = data?.deliveries.filter((d: any) => d.status !== 'DELIVERED') ?? [];
  const done = data?.deliveries.filter((d: any) => d.status === 'DELIVERED') ?? [];

  return (
    <Page title={`Salom, ${user.name.split(' ')[0]}!`} subtitle={`${WEEKDAYS_UZ[weekday(today)]}, ${formatDateHuman(today)}`}>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && (
        <div className="space-y-3">
          <Skeleton className="h-28" />
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
          <Skeleton className="h-48" />
        </div>
      )}
      {data && (
        <>
          {/* Hero: money today */}
          <Card className="bg-brand text-brand-ink">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[14px] opacity-80">Bugun yig'iladigan pul</div>
                <div className="num mt-0.5 text-[30px] leading-tight font-bold">{formatMoney(data.toCollectToday)}</div>
              </div>
              <span className="rounded-full bg-white/15 px-3 py-1 text-[13px] font-semibold">{pending.length} ta yetkazish</span>
            </div>
            <div className="mt-3 flex gap-4 text-[14px]">
              <div>
                <div className="opacity-70">Yig'ildi</div>
                <div className="num font-semibold text-accent">{formatMoney(data.collectedToday)}</div>
              </div>
              {!driver && (
                <div>
                  <div className="opacity-70">Sotildi</div>
                  <div className="num font-semibold">{formatMoney(data.revenueToday)}</div>
                </div>
              )}
              {owner && data.grossProfitToday != null && (
                <div>
                  <div className="opacity-70">Foyda</div>
                  <div className="num font-semibold">{formatMoney(data.grossProfitToday)}</div>
                </div>
              )}
            </div>
          </Card>

          {/* Tashkent cutoff */}
          {owner && data.tashkent && data.tashkent.packs > 0 && !data.tashkent.orderedToday && (
            <Card className="mt-3 border-2 border-accent" onClick={() => nav.push('supplier-proposal')}>
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-warn-soft text-[22px]">📦</span>
                <div className="flex-1">
                  <div className="font-bold">Toshkentga buyurtma: {data.tashkent.packs} blok</div>
                  <div className="text-[13px] text-muted">
                    {WEEKDAYS_UZ[weekday(data.tashkent.arrivalDate)]} uchun · {dayLabel(data.tashkent.orderDay).toLowerCase()} {data.tashkent.cutoff} gacha
                  </div>
                </div>
                <Icon name="chevron" className="text-muted" />
              </div>
            </Card>
          )}

          {/* Debt */}
          {data.debt && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Stat label="Jami qarz" value={formatMoney(data.debt.total)} onClick={() => nav.push('debtors')} />
              <Stat label="Muddati o'tgan" value={formatMoney(data.debt.overdue)} tone={data.debt.overdue > 0 ? 'danger' : undefined} onClick={() => nav.push('debtors')} />
            </div>
          )}
          {data.myOrdersToday && !owner && (
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Stat label="Bugungi buyurtmalar" value={`${data.myOrdersToday.count} ta`} sub={formatMoney(data.myOrdersToday.total)} />
              <Stat label="Tashriflar" value={`${data.visitsToday} ta`} onClick={() => nav.push('visits')} />
            </div>
          )}

          {/* Deliveries */}
          <Section
            title={`Bugun yetkazish (${pending.length})`}
            action={
              data.deliveries.length > 0 ? (
                <button className="text-[14px] font-semibold text-brand" onClick={() => nav.push('route')}>
                  🗺 Marshrut
                </button>
              ) : undefined
            }
          >
            {pending.length === 0 ? (
              <Card className="text-center text-muted">
                {done.length ? `Hammasi yetkazildi ✅ (${done.length})` : "Bugun yetkazish yo'q"}
                {data.tomorrowCount > 0 && <div className="mt-1 text-[14px]">Ertaga: {data.tomorrowCount} ta</div>}
              </Card>
            ) : (
              <List>
                {pending.map((o: any) => (
                  <Row
                    key={o.id}
                    title={o.shop.name}
                    subtitle={`${o.packs} blok · ${o.shop.address ?? o.number}`}
                    right={
                      <div className="flex flex-col items-end gap-1">
                        <Money value={o.total} className="font-semibold" />
                        <StatusBadge kind="order" status={o.status} small />
                      </div>
                    }
                    onClick={() => nav.push('order', { id: o.id })}
                  />
                ))}
              </List>
            )}
          </Section>

          {/* Reminders */}
          {data.reminders.length > 0 && (
            <Section title="Eslatmalar" action={<button className="text-[14px] font-semibold text-brand" onClick={() => nav.push('reminders')}>Hammasi</button>}>
              <List>
                {data.reminders.map((r: any) => (
                  <Row
                    key={r.id}
                    left={<span className="text-[20px]">🔔</span>}
                    title={r.note}
                    subtitle={r.shop?.name}
                    chevron={false}
                    onClick={r.shop ? () => nav.push('shop', { id: r.shop.id }) : undefined}
                    right={
                      <button
                        aria-label="Bajarildi"
                        className="flex h-11 w-11 items-center justify-center rounded-full bg-ok-soft text-ok"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await api.post(`/reminders/${r.id}/done`);
                          invalidate('/today', '/reminders');
                          toast('Bajarildi ✅', {
                            undo: async () => {
                              await api.post(`/reminders/${r.id}/reopen`).catch(() => {});
                              invalidate('/today', '/reminders');
                            },
                          });
                        }}
                      >
                        <Icon name="check" />
                      </button>
                    }
                  />
                ))}
              </List>
            </Section>
          )}

          {/* Overdue shops */}
          {data.debt && data.debt.topOverdue.length > 0 && (
            <Section title="Qarzni so'rash kerak">
              <List>
                {data.debt.topOverdue.map((d: any) => (
                  <Row key={d.shopId} title={d.name} right={<Money value={d.overdue} className="font-semibold text-danger" />} onClick={() => nav.push('shop', { id: d.shopId })} />
                ))}
              </List>
            </Section>
          )}

          {/* Stock */}
          {data.stock && (data.stock.low.length > 0 || data.stock.expiring > 0) && (
            <Section title="Ombor">
              <Card onClick={() => nav.setTab('stock')}>
                {data.stock.low.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 font-semibold">Kam qoldi:</span>
                    {data.stock.low.slice(0, 8).map((s: any) => (
                      <Badge key={s.productId} tone={s.available < 0 ? 'danger' : 'warn'}>
                        {s.flavour} {formatQty(s.available, s.packSize)}
                      </Badge>
                    ))}
                  </div>
                )}
                {data.stock.expiring > 0 && <div className={cx('text-[14px] text-warn', data.stock.low.length && 'mt-2')}>⏳ Muddati yaqin partiyalar: {data.stock.expiring} ta</div>}
              </Card>
            </Section>
          )}

          {!driver && (
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Button variant="secondary" icon="wallet" onClick={() => nav.push('payment-new')}>
                To'lov
              </Button>
              <Button variant="secondary" icon="pin" onClick={() => nav.push('visit-new')}>
                Tashrif
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
