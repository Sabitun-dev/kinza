import type { ComponentType } from 'react';
import { Page } from '../ui/page';
import { EmptyState } from '../ui/kit';
import { TodayTab } from './today/TodayTab';
import { MoreTab } from './more/MoreTab';
import { SettingsScreen } from './more/Settings';
import { UsersScreen } from './more/Users';

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
  'tab:shops': Soon,
  'tab:stock': Soon,
  'tab:more': MoreTab,
  settings: SettingsScreen,
  users: UsersScreen,
  'not-found': Soon,
};
