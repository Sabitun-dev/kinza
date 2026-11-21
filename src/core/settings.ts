import type { DbOrTx } from './db.ts';

/** Every business rule that can change lives here. Defaults follow the agreed plan. */
export const DEFAULT_SETTINGS = {
  // Business details (PDF header)
  businessName: 'KINZA DISTRO',
  businessPhone: '',
  businessAddress: 'Namangan',
  logoFileId: null as number | null,
  legalName: '',
  stir: '',
  bankName: '',
  mfo: '',
  bankAccount: '',

  // Document numbers: {prefix}-{year}-{number}
  waybillPrefix: 'KD',
  orderPrefix: 'B',
  returnPrefix: 'QD',
  reconciliationPrefix: 'AS',
  supplierOrderPrefix: 'T',
  numberDigits: 4,

  // Products
  defaultPackSize: 24,

  // Delivery
  deliveryDays: 2,
  skipSundays: true,
  /** Confirm orders even when stock has not arrived yet (stock goes negative = "to order"). */
  allowConfirmWithoutStock: true,

  // Tashkent supplier
  supplierCutoffTime: '18:00',
  supplierLeadDays: 1,
  cutoffReminderTime: '15:00',
  safetyStockPacks: 5,
  supplierMinPacks: 10,
  supplierName: 'Toshkent',

  // Prices
  agentMaxDiscountBp: 500, // 5%
  costMethod: 'batch' as 'batch' | 'average',

  // Money
  paymentDays: 7,

  // Warnings
  lowStockPacks: 10,
  expiryWarnDays: 30,
  noOrderAlertDays: 10,

  // Reminders
  morningDigestTime: '08:00',
  eveningDigestTime: '20:00',
  backupTime: '03:00',
  backupKeepDays: 30,

  // Lists
  expenseCategories: [] as string[], // seeded into expense_categories table at first start

  // Filled by /setup
  botUsername: '',
  appUrl: '',
};

export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

/** Keys an agent or driver may read (no costs, no bank details). */
export const PUBLIC_SETTING_KEYS: SettingKey[] = [
  'businessName',
  'businessPhone',
  'defaultPackSize',
  'deliveryDays',
  'skipSundays',
  'agentMaxDiscountBp',
  'paymentDays',
  'lowStockPacks',
  'botUsername',
];

export async function getSettings(db: DbOrTx): Promise<Settings> {
  const rows = await db.setting.findMany();
  const s = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) s[r.key] = r.value;
  return s as Settings;
}

export async function updateSettings(db: DbOrTx, patch: Partial<Settings>, userId: number | null) {
  const before = await getSettings(db);
  const changed: Partial<Record<SettingKey, unknown>> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const key = k as SettingKey;
    const def = DEFAULT_SETTINGS[key];
    if (def !== null && typeof def !== 'object' && typeof v !== typeof def) {
      throw new Error(`Sozlama noto'g'ri: ${k}`);
    }
    if (JSON.stringify(before[key]) === JSON.stringify(v)) continue;
    changed[key] = v;
    await db.setting.upsert({
      where: { key },
      create: { key, value: v as never, updatedById: userId },
      update: { value: v as never, updatedById: userId },
    });
  }
  return { before, changed };
}

export function pickPublicSettings(s: Settings) {
  return Object.fromEntries(PUBLIC_SETTING_KEYS.map((k) => [k, s[k]]));
}
