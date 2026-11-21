import type { AuthUser, Deps } from '../core/context.ts';
import { addDays, localDate, toDbDate } from '../shared/dates.ts';
import { t } from '../shared/i18n/index.ts';

/**
 * Inline button actions. Format "action:id".
 *   snz:<reminderId> — snooze a reminder by 1 day
 *   rdone:<reminderId> — mark a reminder done
 */
export async function handleCallback(deps: Deps, user: AuthUser, data: string): Promise<string> {
  const [action, rawId] = data.split(':');
  const id = Number(rawId);
  if (action === 'snz' && id) {
    const r = await deps.db.reminder.findFirst({ where: { id, userId: user.id } });
    if (r) {
      await deps.db.reminder.update({
        where: { id },
        data: { snoozedTo: toDbDate(addDays(localDate(deps.now()), 1)) },
      });
    }
    return t('bot.snoozed');
  }
  if (action === 'rdone' && id) {
    await deps.db.reminder.updateMany({ where: { id, userId: user.id }, data: { doneAt: new Date() } });
    return t('bot.done');
  }
  return '';
}
