import type { Config } from '@netlify/functions';
import { createApp, type App } from '../../src/api/app.ts';
import { getDeps } from '../../src/core/deps.ts';

let app: App | undefined;

export default async (req: Request) => {
  app ??= createApp(await getDeps());
  return app.fetch(req);
};

export const config: Config = { path: '/api/*' };
