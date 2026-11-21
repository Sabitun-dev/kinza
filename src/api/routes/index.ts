import type { App } from '../app.ts';
import type { Deps } from '../../core/context.ts';
import { coreRoutes } from './core.ts';

export function registerRoutes(app: App, deps: Deps) {
  coreRoutes(app, deps);
}
