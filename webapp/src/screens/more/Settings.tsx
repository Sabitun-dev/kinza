import { useEffect, useState } from 'react';
import { Page } from '../../ui/page';
import { Card, Field, NumberInput, Section, SkeletonList, TextInput, Toggle, Segmented, List } from '../../ui/kit';
import { PhotoPicker } from '../../ui/photo';
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
  | { key: string; label: string; type: 'choice'; options: { value: string; label: string }[]; hint?: string };

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
                </Field>
              ))}
          </div>
        </Section>
      ))}
    </Page>
  );
}
