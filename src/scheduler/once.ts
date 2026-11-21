import type { Deps } from '../core/context.ts';

/** Marks a once-per-day event. Returns false if it was already done (unique row exists). */
export async function claimOnce(deps: Pick<Deps, 'db'>, userId: number, kind: string, refKey: string, day: string) {
  try {
    await deps.db.notificationSent.create({ data: { userId, kind, refKey, day } });
    return true;
  } catch {
    return false;
  }
}
