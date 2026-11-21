import { Page } from '../../ui/page';
import { List, Row, Section } from '../../ui/kit';
import { Icon, type IconName } from '../../ui/icons';
import { useNav } from '../../nav';
import { useSession, type Role } from '../../session';
import { t } from '@shared/i18n';

interface Item {
  icon: IconName;
  label: string;
  screen: string;
  roles: Role[];
}

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: 'Pul',
    items: [
      { icon: 'alert', label: 'Qarzdorlar', screen: 'debtors', roles: ['OWNER', 'AGENT'] },
      { icon: 'wallet', label: "To'lovlar", screen: 'payments', roles: ['OWNER', 'AGENT', 'DRIVER'] },
      { icon: 'cash', label: "Kassa (qo'ldagi pul)", screen: 'cash', roles: ['OWNER', 'AGENT', 'DRIVER'] },
      { icon: 'return', label: 'Qaytarishlar', screen: 'returns', roles: ['OWNER', 'AGENT'] },
      { icon: 'receipt', label: 'Xarajatlar', screen: 'expenses', roles: ['OWNER'] },
    ],
  },
  {
    title: 'Savdo',
    items: [
      { icon: 'chart', label: 'Hisobotlar', screen: 'dashboard', roles: ['OWNER'] },
      { icon: 'chart', label: 'Mening natijalarim', screen: 'my-dashboard', roles: ['AGENT', 'DRIVER'] },
      { icon: 'kanban', label: 'Leadlar', screen: 'leads', roles: ['OWNER', 'AGENT'] },
      { icon: 'pin', label: 'Tashriflar', screen: 'visits', roles: ['OWNER', 'AGENT'] },
      { icon: 'route', label: 'Bugungi marshrut', screen: 'route', roles: ['OWNER', 'AGENT', 'DRIVER'] },
      { icon: 'bell', label: 'Eslatmalar', screen: 'reminders', roles: ['OWNER', 'AGENT', 'DRIVER'] },
      { icon: 'download', label: 'Eksport (Excel / CSV)', screen: 'exports', roles: ['OWNER'] },
    ],
  },
  {
    title: "Ma'lumotnoma",
    items: [
      { icon: 'stock', label: 'Mahsulotlar', screen: 'products', roles: ['OWNER'] },
      { icon: 'tag', label: 'Narx guruhlari', screen: 'price-groups', roles: ['OWNER'] },
      { icon: 'route', label: 'Hududlar va marshrut kunlari', screen: 'districts', roles: ['OWNER'] },
    ],
  },
  {
    title: 'Boshqaruv',
    items: [
      { icon: 'users', label: 'Xodimlar va takliflar', screen: 'users', roles: ['OWNER'] },
      { icon: 'settings', label: 'Sozlamalar', screen: 'settings', roles: ['OWNER'] },
      { icon: 'backup', label: 'Zaxira nusxa', screen: 'backup', roles: ['OWNER'] },
    ],
  },
];

export function MoreTab() {
  const nav = useNav();
  const { user } = useSession();
  return (
    <Page title={t('tabs.more')} subtitle={`${user.name} · ${t(`roles.${user.role}` as never)}`}>
      {GROUPS.map((g) => {
        const items = g.items.filter((i) => i.roles.includes(user.role));
        if (!items.length) return null;
        return (
          <Section key={g.title} title={g.title}>
            <List>
              {items.map((i) => (
                <Row
                  key={i.screen}
                  left={
                    <span className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-brand-soft text-brand">
                      <Icon name={i.icon} size={20} />
                    </span>
                  }
                  title={i.label}
                  onClick={() => nav.push(i.screen)}
                />
              ))}
            </List>
          </Section>
        );
      })}
      <div className="mt-8 text-center text-[12px] text-muted">KINZA DISTRO · v1</div>
    </Page>
  );
}
