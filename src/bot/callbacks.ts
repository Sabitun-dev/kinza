import type { AuthUser, Deps } from '../core/context.ts';
import { addDays, localDate, toDbDate } from '../shared/dates.ts';
import { t } from '../shared/i18n/index.ts';
import { claimOnce } from '../scheduler/once.ts';

/**
 * Inline button actions. Format "action:…".
 *   snz:<reminderId>     — snooze a custom reminder by 1 day
 *   rdone:<reminderId>   — mark a custom reminder done
 *   sz:<kind>:<ref>      — snooze an automatic alert (overdue / noorder) for tomorrow
 */
export async function handleCallback(deps: Deps, user: AuthUser, data: string): Promise<string> {
  const [action, a, b] = data.split(':');
  const tomorrow = addDays(localDate(deps.now()), 1);
  if (action === 'snz' && Number(a)) {
    await deps.db.reminder.updateMany({ where: { id: Number(a), userId: user.id }, data: { snoozedTo: toDbDate(tomorrow) } });
    return t('bot.snoozed');
  }
  if (action === 'rdone' && Number(a)) {
    await deps.db.reminder.updateMany({ where: { id: Number(a), userId: user.id }, data: { doneAt: new Date() } });
    return t('bot.done');
  }
  if (action === 'sz' && a && b) {
    // Pre-claim tomorrow's alert so it is not sent again tomorrow
    await claimOnce(deps, user.id, a, b, tomorrow);
    return t('bot.snoozed');
  }
  return '';
}
