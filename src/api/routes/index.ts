import type { App } from '../app.ts';
import type { Deps } from '../../core/context.ts';
import { coreRoutes } from './core.ts';
import { productRoutes } from './products.ts';
import { shopRoutes } from './shops.ts';
import { stockRoutes } from './stock.ts';
import { orderRoutes } from './orders.ts';

export function registerRoutes(app: App, deps: Deps) {
  coreRoutes(app, deps);
  productRoutes(app);
  shopRoutes(app);
  stockRoutes(app);
  orderRoutes(app);
}
