import { lazy, Suspense, useEffect, useState } from 'react';
import { Page } from '../../ui/page';
import { Button, Card, Chip, Chips, Field, MoneyInput, NumberInput, Section, Skeleton, TextArea, TextInput, cx } from '../../ui/kit';
import { ChoiceSheet } from '../../ui/sheet';
import { PhotoPicker } from '../../ui/photo';
import { Icon } from '../../ui/icons';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { useIsOwner } from '../../session';
import { toast } from '../../ui/toast';
import { getPosition } from '../../util';
import { haptic } from '../../tg';
import { t } from '@shared/i18n';
import { WEEKDAYS_UZ } from '@shared/dates';

const PinPicker = lazy(() => import('../../map/PinPicker'));

const STATUSES = ['LEAD', 'SAMPLE', 'ORDERED', 'REGULAR', 'INACTIVE'] as const;

type Form = Record<string, any>;

export function ShopEdit({ id }: { id?: number }) {
  const nav = useNav();
  const owner = useIsOwner();
  const existing = useApi<any>(id ? `/shops/${id}` : null);
  const districts = useApi<{ districts: any[] }>('/districts');
  const groups = useApi<{ groups: any[] }>('/price-groups');
  const users = useApi<{ users: any[] }>(owner ? '/users' : null);
  const [f, setF] = useState<Form>({ name: '', phones: [''], status: 'LEAD', frequency: 'WEEKLY', priority: 0 });
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [sheet, setSheet] = useState<'' | 'district' | 'group' | 'agent'>('');
  const [legalOpen, setLegalOpen] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    const s = existing.data?.shop;
    if (!s) return;
    setF({ ...s, phones: s.phones?.length ? s.phones : [''], districtId: s.districtId, priceGroupId: s.priceGroupId, agentId: s.agentId });
    setPhotoUrl(s.photoUrl);
    if (s.stir || s.legalName) setLegalOpen(true);
  }, [existing.data]);

  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));

  const locate = async () => {
    setLocating(true);
    const p = await getPosition(10000);
    setLocating(false);
    if (!p) return toast.error("Joylashuvni aniqlab bo'lmadi. Telefonda GPS yoqilganini tekshiring.");
    haptic.success();
    setF((x) => ({ ...x, lat: p.lat, lng: p.lng }));
    toast(`Joylashuv saqlandi (±${Math.round(p.accuracy)} m)`);
  };

  const missing = f.status === 'INACTIVE' ? [] : [!f.districtId && 'hudud', f.lat == null && 'joylashuv'].filter(Boolean) as string[];

  useMainButton({
    text: missing.length ? `Kerak: ${missing.join(', ')}` : t('common.save'),
    disabled: !f.name?.trim() || missing.length > 0,
    progress: saving,
    onClick: async () => {
      setSaving(true);
      try {
        const payload: Form = {
          name: f.name.trim(),
          contactName: f.contactName || null,
          phones: (f.phones as string[]).map((p) => p.trim()).filter(Boolean),
          address: f.address || null,
          lat: f.lat ?? null,
          lng: f.lng ?? null,
          districtId: f.districtId ?? null,
          status: f.status,
          visitEveryDays: f.visitEveryDays ?? null,
          notes: f.notes || null,
          photoFileId: f.photoFileId ?? null,
          legalName: f.legalName || null,
          stir: f.stir || null,
          bankName: f.bankName || null,
          mfo: f.mfo || null,
          bankAccount: f.bankAccount || null,
          frequency: f.frequency ?? 'WEEKLY',
          weekParity: f.frequency === 'BIWEEKLY' ? (f.weekParity ?? null) : null,
          openFrom: f.openFrom || null,
          openTo: f.openTo || null,
          notBefore: f.notBefore || null,
          priority: f.priority ?? 0,
        };
        if (owner) {
          Object.assign(payload, {
            priceGroupId: f.priceGroupId ?? null,
            paymentDays: f.paymentDays ?? null,
            creditLimit: f.creditLimit ?? null,
            agentId: f.agentId ?? null,
            noOrderAlertDays: f.noOrderAlertDays ?? null,
          });
        }
        if (id) {
          await api.patch(`/shops/${id}`, payload);
          invalidate('/shops');
          toast(t('common.saved'));
          nav.pop();
        } else {
          const r = await api.post('/shops', payload);
          invalidate('/shops');
          toast("Do'kon qo'shildi ✅");
          nav.replace('shop', { id: r.id });
        }
      } catch (e) {
        toast.error(e);
      } finally {
        setSaving(false);
      }
    },
  });

  if (id && !existing.data) {
    return (
      <Page title="Do'kon">
        <Skeleton className="h-[400px]" />
      </Page>
    );
  }

  const district = districts.data?.districts.find((d) => d.id === f.districtId);
  const group = groups.data?.groups.find((g) => g.id === f.priceGroupId);
  const agent = users.data?.users.find((u) => u.id === f.agentId);

  return (
    <Page title={id ? 'Tahrirlash' : "Yangi do'kon"}>
      <div className="space-y-4">
        <Field label="Do'kon nomi *">
          <TextInput value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Masalan: Baraka market" autoFocus={!id} />
        </Field>
        <Field label="Egasi / mas'ul shaxs">
          <TextInput value={f.contactName ?? ''} onChange={(e) => set('contactName', e.target.value)} />
        </Field>
        <Field label="Telefon">
          <div className="space-y-2">
            {(f.phones as string[]).map((p, i) => (
              <TextInput
                key={i}
                type="tel"
                inputMode="tel"
                value={p}
                placeholder="+998 90 123 45 67"
                onChange={(e) => set('phones', (f.phones as string[]).map((x, k) => (k === i ? e.target.value : x)))}
              />
            ))}
            {(f.phones as string[]).length < 3 && (
              <button className="h-10 px-1 text-[15px] font-semibold text-brand" onClick={() => set('phones', [...f.phones, ''])}>
                + Yana telefon
              </button>
            )}
          </div>
        </Field>
        <Field label="Manzil / mo'ljal">
          <TextInput value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} placeholder="Chust yo'li, bozor yonida" />
        </Field>

        <Card>
          <div className="flex items-center gap-3">
            <div className={cx('flex h-11 w-11 items-center justify-center rounded-full', f.lat ? 'bg-ok-soft text-ok' : 'bg-card2 text-muted')}>
              <Icon name="pin" />
            </div>
            <div className="flex-1">
              <div className="font-semibold">{f.lat ? 'Joylashuv saqlangan' : "Joylashuv yo'q"}</div>
              <div className="text-[13px] text-muted">{f.lat ? `${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}` : "Do'konda turib tugmani bosing"}</div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button size="md" variant="soft" icon="pin" loading={locating} onClick={locate}>
              Mening joylashuvim
            </Button>
            <Button size="md" variant="secondary" icon="search" onClick={() => setShowMap((v) => !v)}>
              Xaritada
            </Button>
          </div>
          {showMap && (
            <div className="mt-3">
              <Suspense fallback={<Skeleton className="h-56" />}>
                <PinPicker lat={f.lat ?? null} lng={f.lng ?? null} onChange={(p) => setF((x) => ({ ...x, ...p }))} />
              </Suspense>
            </div>
          )}
        </Card>

        <Field label="Hudud / hafta kuni *">
          <button className="flex h-[52px] w-full items-center justify-between rounded-[14px] border border-line bg-card px-4 text-left" onClick={() => setSheet('district')}>
            <span className={district ? '' : 'text-muted'}>{district ? `${district.name}${district.routeDay ? ' · ' + WEEKDAYS_UZ[district.routeDay] : ''}` : 'Tanlang'}</span>
            <Icon name="chevronDown" className="text-muted" />
          </button>
        </Field>

        <Field label="Tashrif *">
          <div className="flex flex-wrap gap-2">
            <Chip active={f.frequency !== 'BIWEEKLY'} onClick={() => set('frequency', 'WEEKLY')}>Har hafta</Chip>
            <Chip active={f.frequency === 'BIWEEKLY'} onClick={() => set('frequency', 'BIWEEKLY')}>2 haftada bir</Chip>
            {f.frequency === 'BIWEEKLY' && !district?.weekParity && (
              <>
                <Chip active={(f.weekParity ?? 'ODD') === 'ODD'} onClick={() => set('weekParity', 'ODD')}>Toq hafta</Chip>
                <Chip active={f.weekParity === 'EVEN'} onClick={() => set('weekParity', 'EVEN')}>Juft hafta</Chip>
              </>
            )}
          </div>
        </Field>

        <div className="grid grid-cols-3 gap-2">
          <Field label="Ochiladi">
            <TextInput type="time" value={f.openFrom ?? ''} onChange={(e) => set('openFrom', e.target.value)} />
          </Field>
          <Field label="Yopiladi">
            <TextInput type="time" value={f.openTo ?? ''} onChange={(e) => set('openTo', e.target.value)} />
          </Field>
          <Field label="Kelmang (gacha)">
            <TextInput type="time" value={f.notBefore ?? ''} onChange={(e) => set('notBefore', e.target.value)} />
          </Field>
        </div>

        <Field label="Muhimligi">
          <div className="flex flex-wrap gap-2">
            {['Oddiy', 'Muhim', 'Juda muhim'].map((label, k) => (
              <Chip key={k} active={(f.priority ?? 0) === k} onClick={() => set('priority', k)}>
                {label}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="Holati">
          <Chips>
            {STATUSES.map((s) => (
              <Chip key={s} active={f.status === s} onClick={() => set('status', s)}>
                {t(`shopStatus.${s}` as never)}
              </Chip>
            ))}
          </Chips>
        </Field>

        {owner && (
          <Section title="Savdo shartlari">
            <div className="space-y-4">
              <Field label="Narx guruhi">
                <button className="flex h-[52px] w-full items-center justify-between rounded-[14px] border border-line bg-card px-4 text-left" onClick={() => setSheet('group')}>
                  <span className={group ? '' : 'text-muted'}>{group?.name ?? 'Asosiy narx'}</span>
                  <Icon name="chevronDown" className="text-muted" />
                </button>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="To'lov muddati">
                  <NumberInput value={f.paymentDays ?? null} onChange={(v) => set('paymentDays', v)} suffix="kun" />
                </Field>
                <Field label="Tashrif har">
                  <NumberInput value={f.visitEveryDays ?? null} onChange={(v) => set('visitEveryDays', v)} suffix="kun" />
                </Field>
              </div>
              <Field label="Kredit limiti (ixtiyoriy)" hint="Qarz shundan oshsa ogohlantiradi">
                <MoneyInput value={f.creditLimit ?? null} onChange={(v) => set('creditLimit', v)} />
              </Field>
              <Field label='"Buyurtma bermadi" ogohlantirishi'>
                <NumberInput value={f.noOrderAlertDays ?? null} onChange={(v) => set('noOrderAlertDays', v)} suffix="kun" />
              </Field>
              <Field label="Agent">
                <button className="flex h-[52px] w-full items-center justify-between rounded-[14px] border border-line bg-card px-4 text-left" onClick={() => setSheet('agent')}>
                  <span className={agent ? '' : 'text-muted'}>{agent?.name ?? "O'zim"}</span>
                  <Icon name="chevronDown" className="text-muted" />
                </button>
              </Field>
            </div>
          </Section>
        )}

        <Field label="Izoh">
          <TextArea value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} placeholder="Masalan: faqat ertalab qabul qiladi" />
        </Field>

        <Field label="Do'kon rasmi">
          <PhotoPicker kind="SHOP_PHOTO" url={photoUrl} onUploaded={(p) => (set('photoFileId', p.id), setPhotoUrl(p.url))} />
        </Field>

        <Card padded={false}>
          <button className="flex min-h-[56px] w-full items-center justify-between px-4" onClick={() => setLegalOpen((v) => !v)}>
            <span className="font-semibold">Rekvizitlar (rasmiy hujjat uchun)</span>
            <Icon name={legalOpen ? 'chevronDown' : 'chevron'} className="text-muted" />
          </button>
          {legalOpen && (
            <div className="space-y-3 px-4 pb-4">
              <Field label="Korxona nomi">
                <TextInput value={f.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} />
              </Field>
              <Field label="STIR (INN)">
                <TextInput inputMode="numeric" value={f.stir ?? ''} onChange={(e) => set('stir', e.target.value)} />
              </Field>
              <Field label="Bank">
                <TextInput value={f.bankName ?? ''} onChange={(e) => set('bankName', e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="MFO">
                  <TextInput inputMode="numeric" value={f.mfo ?? ''} onChange={(e) => set('mfo', e.target.value)} />
                </Field>
                <Field label="Hisob raqam">
                  <TextInput inputMode="numeric" value={f.bankAccount ?? ''} onChange={(e) => set('bankAccount', e.target.value)} />
                </Field>
              </div>
            </div>
          )}
        </Card>
      </div>

      <ChoiceSheet
        open={sheet === 'district'}
        onClose={() => setSheet('')}
        title="Hudud"
        value={f.districtId ?? null}
        options={[{ value: 0, label: 'Tanlanmagan' }, ...(districts.data?.districts ?? []).map((d) => ({ value: d.id, label: d.name, sub: d.routeDay ? WEEKDAYS_UZ[d.routeDay] : undefined }))]}
        onPick={(v) => set('districtId', v || null)}
      />
      <ChoiceSheet
        open={sheet === 'group'}
        onClose={() => setSheet('')}
        title="Narx guruhi"
        value={f.priceGroupId ?? 0}
        options={[{ value: 0, label: 'Asosiy narx' }, ...(groups.data?.groups ?? []).filter((g) => !g.archived).map((g) => ({ value: g.id, label: g.name }))]}
        onPick={(v) => set('priceGroupId', v || null)}
      />
      <ChoiceSheet
        open={sheet === 'agent'}
        onClose={() => setSheet('')}
        title="Agent"
        value={f.agentId ?? 0}
        options={[{ value: 0, label: "O'zim" }, ...(users.data?.users ?? []).filter((u) => u.role === 'AGENT' && u.active).map((u) => ({ value: u.id, label: u.name }))]}
        onPick={(v) => set('agentId', v || null)}
      />
    </Page>
  );
}
