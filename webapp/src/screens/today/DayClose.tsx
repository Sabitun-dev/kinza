import { useState } from 'react';
import { Page } from '../../ui/page';
import { Button, Card, Chip, EmptyState, Field, List, Row, Section, Skeleton, SkeletonList, TextInput, cx } from '../../ui/kit';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { toast } from '../../ui/toast';
import { confirmDialog } from '../../tg';
import { addDays, dayLabel, localDate } from '../../util';
import { formatMoney } from '@shared/money';
import { STATUS_META, type ChecklistRow } from './Checklist';
import { CarCountSection, useCarCount } from '../stock/CarCount';

type Choice = 'tomorrow' | 'friday' | 'nextweek' | 'visited';
const CHOICES: [Choice, string][] = [
  ['tomorrow', 'Ertaga'],
  ['friday', 'Juma'],
  ['nextweek', 'Keyingi hafta'],
  ['visited', 'Bugun bordim'],
];

/** "Kun yakuni": decide for every ⏳ shop, count the car, see cash in hand, close the day. */
export function DayCloseScreen({ checklistId }: { checklistId?: number }) {
  const nav = useNav();
  const { data } = useApi<any>('/checklist');
  const cash = useApi<{ people: any[] }>('/cash');
  const car = useCarCount();
  const [choice, setChoice] = useState<Record<number, Choice>>({});
  const [busy, setBusy] = useState(false);
  const id = checklistId ?? data?.id;
  const items: ChecklistRow[] = data?.items ?? [];
  const pending = items.filter((i) => i.status === 'PENDING');
  const missing = pending.filter((i) => !choice[i.id]);

  useMainButton({
    text: missing.length ? `Yana ${missing.length} ta do'kon belgilanmagan` : 'Kunni yopish',
    disabled: missing.length > 0 || !id,
    progress: busy,
    onClick: async () => {
      if (car.hasDiff && !(await confirmDialog(`Mashinada farq bor: ${car.diffText}. Tasdiqlaysizmi?`))) return;
      setBusy(true);
      try {
        await car.save();
        await api.post(`/checklist/${id}/close`, { decisions: pending.map((i) => ({ itemId: i.id, choice: choice[i.id] })) });
        invalidate('/checklist', '/today', '/products', '/stock');
        toast('Kun yopildi ✅ Rahmat!');
        nav.pop();
      } catch (e) {
        toast.error(e);
      } finally {
        setBusy(false);
      }
    },
  });

  if (!data) return <Page title="Kun yakuni"><SkeletonList /></Page>;
  if (data.dayOff || !data.items) return <Page title="Kun yakuni"><EmptyState icon="calendar" title="Bugun yopiladigan ro'yxat yo'q" /></Page>;
  const sold = items.filter((i) => i.status === 'SOLD' || i.status === 'DELIVERED').length;
  const myCash = cash.data?.people?.[0];
  return (
    <Page title="Kun yakuni" subtitle={`${data.done} / ${data.total} do'kon`}>
      <div className="grid grid-cols-3 gap-2">
        <Card className="p-3">
          <div className="text-[12px] text-muted">Sotildi</div>
          <div className="text-[20px] font-bold">{sold}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[12px] text-muted">Yig'ildi</div>
          <div className="num text-[15px] font-bold">{formatMoney(data.collected)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[12px] text-muted">Km</div>
          <div className="num text-[15px] font-bold">{data.drivenKm != null ? Math.round(data.drivenKm) : '—'} / {data.plannedKm != null ? Math.round(data.plannedKm) : '—'}</div>
        </Card>
      </div>
      {myCash && (
        <Card className="mt-3 bg-warn-soft shadow-none">
          Qo'ldagi pul: <b className="num">{formatMoney(myCash.total)}</b>
        </Card>
      )}

      {pending.length > 0 && (
        <Section title={`Borilmagan do'konlar (${pending.length}) — har biriga qaror`}>
          <div className="space-y-2">
            {pending.map((i) => (
              <Card key={i.id} className={cx(!choice[i.id] && 'ring-2 ring-danger')}>
                <div className="font-bold">{i.shop.name}</div>
                <div className="text-[13px] text-muted">{i.shop.address}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {CHOICES.map(([k, label]) => (
                    <Chip key={k} active={choice[i.id] === k} onClick={() => setChoice((c) => ({ ...c, [i.id]: k }))}>
                      {label}
                    </Chip>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </Section>
      )}

      <CarCountSection car={car} />

      <Section title="Bugungi natija">
        <List>
          {items
            .filter((i) => i.status !== 'PENDING')
            .map((i) => (
              <Row key={i.id} title={i.shop.name} right={<span className="text-[13px]">{STATUS_META[i.status].icon} {STATUS_META[i.status].label}</span>} />
            ))}
        </List>
      </Section>
    </Page>
  );
}

/** "Qamrov": % of due shops visited this week, and who was missed. */
export function CoverageScreen() {
  const nav = useNav();
  const [week, setWeek] = useState<'this' | 'last'>('this');
  const today = localDate();
  const wd = new Date(today + 'T00:00:00Z').getUTCDay() || 7;
  const monday = addDays(today, 1 - wd - (week === 'last' ? 7 : 0));
  const to = week === 'last' ? addDays(monday, 6) : today;
  const { data } = useApi<any>(`/coverage?from=${monday}&to=${to}`);
  return (
    <Page title="Qamrov" subtitle={`${dayLabel(monday)} — ${dayLabel(to)}`}>
      <div className="flex gap-2">
        <Chip active={week === 'this'} onClick={() => setWeek('this')}>Shu hafta</Chip>
        <Chip active={week === 'last'} onClick={() => setWeek('last')}>O'tgan hafta</Chip>
      </div>
      {!data ? (
        <Skeleton className="mt-3 h-40" />
      ) : (
        <>
          <Card className={cx('mt-3', data.percent >= 90 ? 'bg-ok-soft' : data.percent >= 70 ? 'bg-warn-soft' : 'bg-danger-soft', 'shadow-none')}>
            <div className="text-[14px] text-muted">Rejadagi do'konlarga borildi</div>
            <div className="text-[34px] font-bold">{data.percent}%</div>
            <div className="text-[14px]">
              {data.visited} / {data.due} do'kon
            </div>
          </Card>
          {data.missed.length > 0 && (
            <Section title="Borilmaganlar">
              <List>
                {data.missed.map((m: any) => (
                  <Row key={m.id} title={m.name} subtitle={`reja: ${dayLabel(m.dueDate)} · ${m.address ?? ''}`} right={<span className="text-[13px] font-semibold text-danger">{m.daysSinceVisit != null ? `${m.daysSinceVisit} kun` : 'hech qachon'}</span>} onClick={() => nav.push('shop', { id: m.id })} />
                ))}
              </List>
            </Section>
          )}
        </>
      )}
    </Page>
  );
}

/** Days off (holidays). Their shops roll over to the next working day. */
export function HolidaysScreen() {
  const { data, reload } = useApi<{ holidays: { date: string; note: string | null }[] }>('/holidays');
  const [date, setDate] = useState(addDays(localDate(), 1));
  const [note, setNote] = useState('');
  return (
    <Page title="Dam olish kunlari" subtitle="Yakshanba doim dam olish">
      <Card>
        <Field label="Sana">
          <TextInput type="date" value={date} min={localDate()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="mt-2">
          <TextInput placeholder="Izoh (masalan: Navro'z)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button
          block
          className="mt-3"
          onClick={async () => {
            await api.post('/holidays', { date, note: note || null });
            setNote('');
            reload();
            invalidate('/checklist');
            toast('Saqlandi ✅');
          }}
        >
          Qo'shish
        </Button>
      </Card>
      <Section title="Belgilangan kunlar">
        <List>
          {(data?.holidays ?? []).map((h) => (
            <Row
              key={h.date}
              title={dayLabel(h.date)}
              subtitle={h.note ?? undefined}
              right={
                <button
                  className="h-10 px-2 font-semibold text-danger"
                  onClick={async () => {
                    await api.post(`/holidays/${h.date}/delete`);
                    reload();
                  }}
                >
                  O'chirish
                </button>
              }
            />
          ))}
        </List>
      </Section>
    </Page>
  );
}
