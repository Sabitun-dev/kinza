import type { Deps } from '../core/context.ts';
import { getSettings, type Settings } from '../core/settings.ts';
import { localDate, localTime, localParts } from '../shared/dates.ts';
import { runBackup } from '../backup/backup.ts';
import { scheduledJobs } from './jobs.ts';
import { claimOnce } from './once.ts';

export { claimOnce };

export interface Job {
  name: string;
  /** "HH:MM" Tashkent time after which the job runs once per day. */
  at: (s: Settings) => string;
  run: (deps: Deps, s: Settings, day: string) => Promise<string | void>;
}

const SYSTEM_USER = 0;

export const backupJob: Job = {
  name: 'backup',
  at: (s) => s.backupTime,
  run: async (deps, _s, day) => {
    // Every Sunday the backup is also sent to the owners' chat.
    const sunday = localParts(deps.now()).weekday === 7;
    const owners = sunday ? await deps.db.user.findMany({ where: { role: 'OWNER', active: true } }) : [];
    const first = await runBackup(deps, { reason: 'daily', sendTo: owners.map((o) => Number(o.telegramId)) });
    return `backup ${first.key} ${day}`;
  },
};

/**
 * Called every 15 minutes. Each job runs once per day, at the first tick after its time,
 * so a missed tick is caught up on the next one.
 */
export async function runScheduler(deps: Deps) {
  const run = await deps.db.schedulerRun.create({ data: {} });
  const log: string[] = [];
  let ok = true;
  try {
    const s = await getSettings(deps.db);
    const now = deps.now();
    const day = localDate(now);
    const time = localTime(now);
    for (const job of [backupJob, ...scheduledJobs]) {
      if (time < job.at(s)) continue;
      if (!(await claimOnce(deps, SYSTEM_USER, `job:${job.name}`, '', day))) continue;
      try {
        const r = await job.run(deps, s, day);
        log.push(`${job.name}: ${r ?? 'ok'}`);
      } catch (err) {
        ok = false;
        log.push(`${job.name}: FAILED ${(err as Error).message}`);
        console.error('Job failed', job.name, err);
      }
    }
  } catch (err) {
    ok = false;
    log.push(`FAILED ${(err as Error).message}`);
  }
  await deps.db.schedulerRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), ok, log: log.join('\n').slice(0, 4000) || null },
  });
  return { ok, log };
}
