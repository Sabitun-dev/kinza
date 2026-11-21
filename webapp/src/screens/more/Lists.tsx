import { useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Chip, Chips, Field, IconButton, List, Row, SkeletonList, TextInput } from '../../ui/kit';
import { Sheet } from '../../ui/sheet';
import { api, invalidate, useApi } from '../../api';
import { toast } from '../../ui/toast';
import { t } from '@shared/i18n';
import { WEEKDAYS_UZ } from '@shared/dates';

/** Price groups (Supermarket / Do'kon / Ulgurji …). Prices per group are set on each product. */
export function PriceGroupsScreen() {
  const { data } = useApi<{ groups: { id: number; name: string; archived: boolean; shops: number }[] }>('/price-groups');
  const [edit, setEdit] = useState<{ id?: number; name: string; archived?: boolean } | null>(null);
  return (
    <Page title="Narx guruhlari" subtitle="Har bir mahsulotda guruh narxini kiriting" right={<IconButton icon="plus" label="Qo'shish" tone="brand" onClick={() => setEdit({ name: '' })} />}>
      {!data ? (
        <SkeletonList rows={3} />
      ) : (
        <List>
          {data.groups.map((g) => (
            <Row key={g.id} title={g.name} subtitle={`${g.shops} ta do'kon`} right={g.archived ? <Badge>arxiv</Badge> : undefined} onClick={() => setEdit(g)} />
          ))}
        </List>
      )}
      {edit && (
        <NameSheet
          title={edit.id ? 'Guruhni tahrirlash' : 'Yangi guruh'}
          initial={edit.name}
          archived={edit.archived}
          onClose={() => setEdit(null)}
          onSave={async (name, archived) => {
            if (edit.id) await api.patch(`/price-groups/${edit.id}`, { name, archived });
            else await api.post('/price-groups', { name });
            invalidate('/price-groups', '/products');
          }}
        />
      )}
    </Page>
  );
}

/** Districts with route days (e.g. Dushanba: Chust yo'li). */
export function DistrictsScreen() {
  const { data } = useApi<{ districts: { id: number; name: string; routeDay: number | null }[] }>('/districts');
  const [edit, setEdit] = useState<{ id?: number; name: string; routeDay: number | null } | null>(null);
  return (
    <Page title="Hududlar" subtitle="Marshrut kunlari" right={<IconButton icon="plus" label="Qo'shish" tone="brand" onClick={() => setEdit({ name: '', routeDay: null })} />}>
      {!data ? (
        <SkeletonList rows={3} />
      ) : (
        <List>
          {data.districts.map((d) => (
            <Row key={d.id} title={d.name} subtitle={d.routeDay ? WEEKDAYS_UZ[d.routeDay] : 'Kun belgilanmagan'} onClick={() => setEdit(d)} />
          ))}
        </List>
      )}
      {edit && (
        <DistrictSheet
          value={edit}
          onClose={() => setEdit(null)}
          onSave={async (v) => {
            if (edit.id) await api.patch(`/districts/${edit.id}`, v);
            else await api.post('/districts', v);
            invalidate('/districts');
          }}
          onArchive={edit.id ? async () => {
            await api.patch(`/districts/${edit.id}`, { archived: true });
            invalidate('/districts');
          } : undefined}
        />
      )}
    </Page>
  );
}

function NameSheet({ title, initial, archived, onClose, onSave }: { title: string; initial: string; archived?: boolean; onClose: () => void; onSave: (name: string, archived?: boolean) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [arch, setArch] = useState(!!archived);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      footer={
        <Button
          block
          disabled={!name.trim()}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(name.trim(), arch);
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
      <Field label="Nomi">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      {archived !== undefined && (
        <Chips className="mt-3">
          <Chip active={!arch} onClick={() => setArch(false)}>Faol</Chip>
          <Chip active={arch} onClick={() => setArch(true)}>Arxiv</Chip>
        </Chips>
      )}
    </Sheet>
  );
}

function DistrictSheet({ value, onClose, onSave, onArchive }: { value: { name: string; routeDay: number | null }; onClose: () => void; onSave: (v: { name: string; routeDay: number | null }) => Promise<void>; onArchive?: () => Promise<void> }) {
  const [name, setName] = useState(value.name);
  const [day, setDay] = useState<number | null>(value.routeDay);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open
      onClose={onClose}
      title="Hudud"
      footer={
        <div className="space-y-2">
          <Button
            block
            disabled={!name.trim()}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave({ name: name.trim(), routeDay: day });
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
          {onArchive && (
            <Button block variant="ghost" onClick={async () => (await onArchive(), onClose())}>
              Arxivlash
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Nomi">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Chust yo'li" autoFocus />
        </Field>
        <Field label="Marshrut kuni">
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <Chip key={d} active={day === d} onClick={() => setDay(day === d ? null : d)}>
                {WEEKDAYS_UZ[d]}
              </Chip>
            ))}
          </div>
        </Field>
      </div>
    </Sheet>
  );
}
