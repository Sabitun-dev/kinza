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
  'tab:orders': Soon,
  'tab:shops': ShopsTab,
  'tab:stock': StockTab,
  'tab:more': MoreTab,
  shop: ShopDetail,
  'shop-edit': ShopEdit,
  products: ProductsScreen,
  product: ProductDetail,
  'product-edit': ProductEdit,
  'price-groups': PriceGroupsScreen,
  districts: DistrictsScreen,
  settings: SettingsScreen,
  users: UsersScreen,
  'not-found': Soon,
};
