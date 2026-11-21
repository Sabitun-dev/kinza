import type { Config } from '@netlify/functions';
import { getDeps } from '../../src/core/deps.ts';
import { runScheduler } from '../../src/scheduler/run.ts';

/** Runs every 15 minutes: digests, alerts, cutoff reminder, daily backup. */
export default async () => {
  const deps = await getDeps();
  await runScheduler(deps);
};

export const config: Config = { schedule: '*/15 * * * *' };
