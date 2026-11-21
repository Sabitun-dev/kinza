import { useEffect, useState } from 'react';
import { Page } from '../../ui/page';
import { Card, Field, NumberInput, Section, SkeletonList, TextInput, Toggle, Segmented, List } from '../../ui/kit';
import { PhotoPicker } from '../../ui/photo';
import { Button } from '../../ui/kit';
import { getPosition } from '../../util';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { toast } from '../../ui/toast';
import { useSession } from '../../session';
import { t } from '@shared/i18n';

type FieldDef =
  | { key: string; label: string; type: 'text' | 'time'; hint?: string; inputMode?: 'tel' | 'numeric' }
  | { key: string; label: string; type: 'number'; suffix?: string; hint?: string }
  | { key: string; label: string; type: 'bool'; hint?: string }
  | { key: string; label: string; type: 'percentBp'; hint?: string }
  | { key: string; label: string; type: 'choice'; options: { value: string; label: string }[]; hint?: string }
  | { key: string; label: string; type: 'decimal'; suffix?: string; hint?: string }
  | { key: string; label: string; type: 'pin'; latKey: string; lngKey: string; hint?: string };

const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Biznes (hujjatlarda chiqadi)',
    fields: [
      { key: 'businessName', label: 'Nomi', type: 'text' },
      { key: 'businessPhone', label: 'Telefon', type: 'text', inputMode: 'tel' },
      { key: 'businessAddress', label: 'Manzil', type: 'text' },
      { key: 'legalName', label: 'Yuridik nomi (ixtiyoriy)', type: 'text' },
      { key: 'stir', label: 'STIR (INN)', type: 'text', inputMode: 'numeric' },
      { key: 'bankName', label: 'Bank', type: 'text' },
      { key: 'mfo', label: 'MFO', type: 'text', inputMode: 'numeric' },
      { key: 'bankAccount', label: 'Hisob raqam', type: 'text', inputMode: 'numeric' },
    ],
  },
  {
    title: 'Hujjat raqamlari',
    fields: [
      { key: 'waybillPrefix', label: 'Yuk xati prefiksi', type: 'text', hint: 'Masalan: KD → KD-2026-0001' },
      { key: 'orderPrefix', label: 'Buyurtma prefiksi', type: 'text' },
      { key: 'returnPrefix', label: 'Qaytarish prefiksi', type: 'text' },
      { key: 'numberDigits', label: 'Raqam uzunligi', type: 'number', suffix: 'raqam' },
    ],
  },
  {
    title: 'Mahsulot va narx',
    fields: [
      { key: 'defaultPackSize', label: 'Blokda nechta dona (standart)', type: 'number', suffix: 'dona' },
      { key: 'agentMaxDiscountBp', label: 'Agent uchun eng katta chegirma', type: 'percentBp' },
      {
        key: 'costMethod',
        label: 'Tannarx hisoblash',
        type: 'choice',
        options: [
          { value: 'batch', label: 'Partiya bo‘yicha' },
          { value: 'average', label: "O'rtacha" },
        ],
      },
    ],
  },
  {
    title: "Yetkazish va to'lov",
    fields: [
      { key: 'deliveryDays', label: 'Yetkazish muddati', type: 'number', suffix: 'kun' },
      { key: 'skipSundays', label: 'Yakshanba ishlamaymiz', type: 'bool' },
      { key: 'allowConfirmWithoutStock', label: 'Omborda yo‘q bo‘lsa ham tasdiqlash', type: 'bool', hint: 'Toshkentdan keladigan tovarga buyurtma olish' },
      { key: 'paymentDays', label: "To'lov muddati (yetkazilgandan keyin)", type: 'number', suffix: 'kun' },
    ],
  },
  {
    title: 'Toshkent (yetkazib beruvchi)',
    fields: [
      { key: 'supplierName', label: 'Yetkazib beruvchi nomi', type: 'text' },
      { key: 'supplierCutoffTime', label: 'Buyurtma berish oxirgi vaqti', type: 'time' },
      { key: 'supplierLeadDays', label: 'Yetib kelish muddati', type: 'number', suffix: 'kun' },
      { key: 'cutoffReminderTime', label: 'Eslatish vaqti', type: 'time' },
      { key: 'safetyStockPacks', label: 'Zaxira (har ta’m)', type: 'number', suffix: 'blok' },
      { key: 'supplierMinPacks', label: 'Eng kam buyurtma (har ta’m)', type: 'number', suffix: 'blok' },
    ],
  },
  {
    title: 'Ogohlantirishlar',
    fields: [
      { key: 'lowStockPacks', label: 'Kam qoldiq chegarasi', type: 'number', suffix: 'blok' },
      { key: 'expiryWarnDays', label: 'Muddat tugashidan oldin', type: 'number', suffix: 'kun' },
      { key: 'noOrderAlertDays', label: '"Buyurtma bermadi" ogohlantirishi', type: 'number', suffix: 'kun' },
    ],
  },
  {
    title: "Marshrut va yoqilg'i",
    fields: [
      { key: 'warehouse', label: 'Ombor joylashuvi', type: 'pin', latKey: 'warehouseLat', lngKey: 'warehouseLng', hint: "GPS bo'lmasa marshrut shu yerdan boshlanadi" },
      { key: 'home', label: 'Uy joylashuvi', type: 'pin', latKey: 'homeLat', lngKey: 'homeLng' },
      {
        key: 'routeEnd',
        label: 'Kun oxirida qaytish',
        type: 'choice',
        options: [
          { value: 'warehouse', label: 'Omborga' },
          { value: 'home', label: 'Uyga' },
          { value: 'last', label: "Oxirgi do'konda" },
        ],
      },
      { key: 'fuelPer100Km', label: 'Sarf (100 km ga)', type: 'number', suffix: 'litr' },
      { key: 'fuelPrice', label: "Yoqilg'i narxi (1 litr)", type: 'number', suffix: "so'm" },
      { key: 'priorityDetourKm', label: 'Kecha qolganlarni oldinga qo‘yish (ortiqcha yo‘l)', type: 'number', suffix: 'km' },
      { key: 'defaultStopMinutes', label: "Har do'konda o'rtacha", type: 'number', suffix: 'daqiqa' },
    ],
  },
  {
    title: 'Hafta tartibi',
    fields: [
      { key: 'preorderWeekday', label: 'Oldindan buyurtma yetkaziladigan kun (1=Du … 6=Sha)', type: 'number', suffix: 'kun' },
      { key: 'supplierOrderWeekday', label: 'Toshkentga buyurtma kuni (4=Payshanba)', type: 'number', suffix: 'kun' },
      { key: 'supplierArrivalWeekday', label: 'Yuk kelish kuni (6=Shanba)', type: 'number', suffix: 'kun' },
      { key: 'coverWeeks', label: 'Toshkent buyurtmasi necha haftaga', type: 'decimal', suffix: 'hafta' },
      { key: 'loadFactor', label: 'Mashinaga yuklash koeffitsienti', type: 'decimal', suffix: '×' },
      { key: 'middayReminderTime', label: '"Hali qolgan do‘konlar" eslatmasi', type: 'time' },
      { key: 'carryOverTime', label: "Qolganlarni ertaga o'tkazish vaqti", type: 'time' },
    ],
  },
  {
    title: 'Eslatmalar va zaxira',
    fields: [
      { key: 'morningDigestTime', label: 'Ertalabki hisobot', type: 'time' },
      { key: 'eveningDigestTime', label: 'Kechki hisobot', type: 'time' },
      { key: 'backupTime', label: 'Kunlik zaxira nusxa', type: 'time' },
      { key: 'backupKeepDays', label: 'Zaxirani saqlash', type: 'number', suffix: 'kun' },
    ],
  },
];

export function SettingsScreen() {
  const { data, loading, reload } = useApi<Record<string, any>>('/settings');
  const session = useSession();
  const [form, setForm] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  const dirty = data ? Object.keys(form).some((k) => JSON.stringify(form[k]) !== JSON.stringify(data[k])) : false;
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  useMainButton({
    text: t('common.save'),
    visible: dirty,
    progress: saving,
    onClick: async () => {
      setSaving(true);
      try {
        const patch: Record<string, unknown> = {};
        for (const k of Object.keys(form)) if (JSON.stringify(form[k]) !== JSON.stringify(data![k]) && k !== 'logoUrl') patch[k] = form[k];
        await api.put('/settings', patch);
        toast(t('common.saved'));
        invalidate('/settings');
        await reload();
        await session.reload();
      } catch (e) {
        toast.error(e);
      } finally {
        setSaving(false);
      }
    },
  });

  if (loading || !data) {
    return (
      <Page title="Sozlamalar">
        <SkeletonList />
      </Page>
    );
  }

  return (
    <Page title="Sozlamalar">
      <Section title="Logotip">
        <Card className="flex items-center gap-4">
          <PhotoPicker kind="LOGO" url={form.logoUrl} label="Logo" onUploaded={(f) => setForm((x) => ({ ...x, logoFileId: f.id, logoUrl: f.url }))} />
          <div className="text-[14px] text-muted">Logotip yuk xati va boshqa PDF hujjatlarning yuqorisida chiqadi.</div>
        </Card>
      </Section>
      {GROUPS.map((g) => (
        <Section key={g.title} title={g.title}>
          <div className="space-y-3">
            {g.fields.some((f) => f.type === 'bool') && (
              <List>
                {g.fields
                  .filter((f) => f.type === 'bool')
                  .map((f) => (
                    <Toggle key={f.key} label={f.label} hint={f.hint} checked={!!form[f.key]} onChange={(v) => set(f.key, v)} />
                  ))}
              </List>
            )}
            {g.fields
              .filter((f) => f.type !== 'bool')
              .map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  {f.type === 'text' && <TextInput value={form[f.key] ?? ''} inputMode={f.inputMode} onChange={(e) => set(f.key, e.target.value)} />}
                  {f.type === 'time' && <TextInput type="time" value={form[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />}
                  {f.type === 'number' && <NumberInput value={form[f.key] ?? null} suffix={f.suffix} onChange={(v) => set(f.key, v ?? 0)} />}
                  {f.type === 'percentBp' && (
                    <NumberInput value={form[f.key] != null ? form[f.key] / 100 : null} suffix="%" onChange={(v) => set(f.key, Math.min(100, v ?? 0) * 100)} />
                  )}
                  {f.type === 'choice' && <Segmented value={form[f.key]} options={f.options} onChange={(v) => set(f.key, v)} />}
                  {f.type === 'decimal' && (
                    <TextInput inputMode="decimal" defaultValue={String(form[f.key] ?? '')} onChange={(e) => { const v = parseFloat(e.target.value.replace(',', '.')); if (!Number.isNaN(v) && v > 0) set(f.key, v); }} />
                  )}
                  {f.type === 'pin' && (
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 text-[14px] text-muted">{form[f.latKey] != null ? `${Number(form[f.latKey]).toFixed(5)}, ${Number(form[f.lngKey]).toFixed(5)}` : "Belgilanmagan"}</div>
                      <Button
                        size="sm"
                        variant="soft"
                        icon="pin"
                        onClick={async () => {
                          const p = await getPosition(10000);
                          if (!p) return toast.error("Joylashuvni aniqlab bo'lmadi");
                          setForm((x) => ({ ...x, [f.latKey]: p.lat, [f.lngKey]: p.lng }));
                        }}
                      >
                        Mening joylashuvim
                      </Button>
                    </div>
                  )}
                </Field>
              ))}
          </div>
        </Section>
      ))}
    </Page>
  );
}
