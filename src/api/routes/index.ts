import type { App } from '../app.ts';
import type { Deps } from '../../core/context.ts';
import { coreRoutes } from './core.ts';
import { productRoutes } from './products.ts';
import { shopRoutes } from './shops.ts';
import { stockRoutes } from './stock.ts';
import { orderRoutes } from './orders.ts';
import { paymentRoutes } from './payments.ts';
import { supplierRoutes } from './supplier.ts';
import { reminderRoutes } from './reminders.ts';
import { todayRoutes } from './today.ts';
import { reportRoutes } from './reports.ts';
import { checklistRoutes } from './checklist.ts';
import { vanRoutes } from './van.ts';
import { sellRoutes } from './sell.ts';

export function registerRoutes(app: App, deps: Deps) {
  coreRoutes(app, deps);
  productRoutes(app);
  shopRoutes(app);
  stockRoutes(app);
  orderRoutes(app);
  paymentRoutes(app);
  supplierRoutes(app);
  reminderRoutes(app);
  todayRoutes(app);
  reportRoutes(app);
  checklistRoutes(app);
  vanRoutes(app);
  sellRoutes(app);
}
