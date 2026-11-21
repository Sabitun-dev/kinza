import type { ComponentType } from 'react';
import { Page } from '../ui/page';
import { EmptyState } from '../ui/kit';
import { TodayTab } from './today/TodayTab';
import { MoreTab } from './more/MoreTab';
import { SettingsScreen } from './more/Settings';
import { UsersScreen } from './more/Users';
import { PriceGroupsScreen, DistrictsScreen } from './more/Lists';
import { ShopsTab } from './shops/ShopsTab';
import { ShopDetail } from './shops/ShopDetail';
import { ShopEdit } from './shops/ShopEdit';
import { StockTab } from './stock/StockTab';
import { ProductsScreen, ProductDetail, ProductEdit } from './stock/Products';
import { OrdersTab } from './orders/OrdersTab';
import { OrderForm } from './orders/OrderForm';
import { OrderDetail } from './orders/OrderDetail';
import { DeliverScreen } from './orders/Deliver';
import { SyncQueueScreen } from '../offline/SyncQueueScreen';
import { PaymentNew } from './money/PaymentNew';
import { DebtorsScreen } from './money/Debtors';
import { PaymentsScreen, CashScreen, ReturnsScreen, ReturnNew, ReconciliationScreen } from './money/MoneyScreens';
import { SupplierProposal, SupplierOrders, SupplierOrderDetail, SupplierReceive } from './stock/Supplier';
import { StockCountScreen, StockAdjustScreen, BatchesScreen } from './stock/StockOps';

function Soon() {
  return (
    <Page title="KINZA">
      <EmptyState icon="clock" title="Tez orada" text="Bu bo'lim keyingi yangilanishda qo'shiladi." />
    </Page>
  );
}

/** All screens by name. nav.push('order', { id }) renders SCREENS.order with props { id }. */
export const SCREENS: Record<string, ComponentType<any>> = {
  'tab:today': TodayTab,
  'tab:orders': OrdersTab,
  'tab:shops': ShopsTab,
  'tab:stock': StockTab,
  'tab:more': MoreTab,
  order: OrderDetail,
  'order-new': OrderForm,
  'order-edit': OrderForm,
  deliver: DeliverScreen,
  shop: ShopDetail,
  'shop-edit': ShopEdit,
  products: ProductsScreen,
  product: ProductDetail,
  'product-edit': ProductEdit,
  'price-groups': PriceGroupsScreen,
  districts: DistrictsScreen,
  settings: SettingsScreen,
  users: UsersScreen,
  'sync-queue': SyncQueueScreen,
  'payment-new': PaymentNew,
  payments: PaymentsScreen,
  debtors: DebtorsScreen,
  cash: CashScreen,
  returns: ReturnsScreen,
  'return-new': ReturnNew,
  reconciliation: ReconciliationScreen,
  'supplier-proposal': SupplierProposal,
  'supplier-orders': SupplierOrders,
  'supplier-order': SupplierOrderDetail,
  'supplier-receive': SupplierReceive,
  'stock-count': StockCountScreen,
  'stock-adjust': StockAdjustScreen,
  batches: BatchesScreen,
  'not-found': Soon,
};
