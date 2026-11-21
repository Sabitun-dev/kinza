import { useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Chip, Chips, EmptyState, Field, IconButton, List, Row, SkeletonList, TextArea, TextInput } from '../../ui/kit';
import { Sheet, ChoiceSheet } from '../../ui/sheet';
import { Icon } from '../../ui/icons';
import { api, invalidate, useApi } from '../../api';
import { useNav } from '../../nav';
import { toast } from '../../ui/toast';
import { addDays, dayLabel, localDate } from '../../util';

export function RemindersScreen() {
  const nav = useNav();
  const [done, setDone] = useState(false);
  const { data } = useApi<{ reminders: any[] }>(`/reminders${done ? '?done=1' : ''}`);
  const [adding, setAdding] = useState(false);
  return (
    <Page title="Eslatmalar" right={<IconButton icon="plus" label="Qo'shish" tone="brand" onClick={() => setAdding(true)} />}>
      <Chips>
        <Chip active={!done} onClick={() => setDone(false)}>Faol</Chip>
        <Chip active={done} onClick={() => setDone(true)}>Bajarilgan</Chip>
      </Chips>
      <div className="mt-3">
        {!data ? (
          <SkeletonList />
        ) : data.reminders.length === 0 ? (
          <EmptyState icon="bell" title="Eslatma yo'q" action={<Button icon="plus" onClick={() => setAdding(true)}>Eslatma qo'shish</Button>} />
        ) : (
          <List>
            {data.reminders.map((r) => (
              <Row
                key={r.id}
                title={r.note}
                subtitle={[dayLabel(r.dueDate), r.shop?.name].filter(Boolean).join(' · ')}
                onClick={r.shop ? () => nav.push('shop', { id: r.shop.id }) : undefined}
                chevron={false}
                right={
                  r.done ? (
                    <Badge tone="ok">✓</Badge>
                  ) : (
                    <div className="flex gap-1">
                      {r.overdue && <Badge tone="danger">kechikkan</Badge>}
                      <button
                        aria-label="Ertaga"
                        className="flex h-11 w-11 items-center justify-center rounded-full bg-card2 text-muted"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await api.post(`/reminders/${r.id}/snooze`, { days: 1 });
                          invalidate('/reminders', '/today');
                          toast('Ertaga eslataman ⏰');
                        }}
                      >
                        <Icon name="clock" size={20} />
                      </button>
                      <button
                        aria-label="Bajarildi"
                        className="flex h-11 w-11 items-center justify-center rounded-full bg-ok-soft text-ok"
                        onClick={async (e) => {
                          e.stopPropagation();
                          await api.post(`/reminders/${r.id}/done`);
                          invalidate('/reminders', '/today');
                          toast('Bajarildi ✅');
                        }}
                      >
                        <Icon name="check" size={20} />
                      </button>
                    </div>
                  )
                }
              />
            ))}
          </List>
        )}
      </div>
      {adding && <ReminderSheet onClose={() => setAdding(false)} />}
    </Page>
  );
}

export function ReminderSheet({ onClose, shopId: initialShop }: { onClose: () => void; shopId?: number }) {
  const shops = useApi<{ shops: any[] }>('/shops');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(addDays(localDate(), 1));
  const [shopId, setShopId] = useState<number | null>(initialShop ?? null);
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const shop = shops.data?.shops.find((s) => s.id === shopId);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Yangi eslatma"
      footer={
        <Button
          block
          disabled={!note.trim()}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.post('/reminders', { note: note.trim(), dueDate: date, shopId });
              invalidate('/reminders', '/today');
              toast('Eslatma saqlandi ✅');
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
      <div className="space-y-4">
        <TextArea autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Nima qilish kerak?" rows={2} />
        <Field label="Qachon">
          <Chips>
            <Chip active={date === localDate()} onClick={() => setDate(localDate())}>Bugun</Chip>
            <Chip active={date === addDays(localDate(), 1)} onClick={() => setDate(addDays(localDate(), 1))}>Ertaga</Chip>
            <Chip active={date === addDays(localDate(), 7)} onClick={() => setDate(addDays(localDate(), 7))}>1 hafta</Chip>
          </Chips>
          <TextInput type="date" className="mt-2" value={date} min={localDate()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Do'kon (ixtiyoriy)">
          <button className="flex h-[52px] w-full items-center justify-between rounded-[14px] border border-line bg-card px-4 text-left" onClick={() => setPick(true)}>
            <span className={shop ? '' : 'text-muted'}>{shop?.name ?? 'Tanlang'}</span>
            <Icon name="chevronDown" className="text-muted" />
          </button>
        </Field>
      </div>
      <ChoiceSheet open={pick} onClose={() => setPick(false)} title="Do'kon" value={shopId} options={[{ value: 0, label: "Do'konsiz" }, ...(shops.data?.shops ?? []).map((s) => ({ value: s.id, label: s.name }))]} onPick={(v) => setShopId(v || null)} />
    </Sheet>
  );
}
