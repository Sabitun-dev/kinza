import type { DbOrTx } from '../core/db.ts';

export const DEFAULT_PRICE_GROUPS = ['Supermarket', "Do'kon", 'Ulgurji'];
export const DEFAULT_EXPENSE_CATEGORIES = ["Yoqilg'i", 'Transport', 'Chop etish', 'Ijara', 'Oylik', 'Boshqa'];

/** Creates the starting lists if they are empty. Safe to run many times. */
export async function ensureBaseData(db: DbOrTx) {
  const created: string[] = [];
  if ((await db.priceGroup.count()) === 0) {
    await db.priceGroup.createMany({ data: DEFAULT_PRICE_GROUPS.map((name, i) => ({ name, sortOrder: i })) });
    created.push('price groups');
  }
  if ((await db.expenseCategory.count()) === 0) {
    await db.expenseCategory.createMany({
      data: DEFAULT_EXPENSE_CATEGORIES.map((name, i) => ({ name, sortOrder: i })),
    });
    created.push('expense categories');
  }
  return created;
}
