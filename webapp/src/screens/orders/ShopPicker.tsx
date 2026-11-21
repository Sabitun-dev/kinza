import { useEffect, useState } from 'react';
import { Page } from '../../ui/page';
import { Button, EmptyState, List, SearchInput, SkeletonList, useDebounced, Section } from '../../ui/kit';
import { useApi } from '../../api';
import { useNav } from '../../nav';
import { roughPosition } from '../../util';
import { ShopRow, type ShopListItem } from '../shops/ShopsTab';

/** Step 1 of a new order: nearby shops first (GPS), then recent, then search. */
export function ShopPicker({ title, onPick }: { title: string; onPick: (shopId: number) => void }) {
  const nav = useNav();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null | undefined>(undefined);
  useEffect(() => {
    roughPosition().then((p) => setPos(p));
  }, []);
  const ready = pos !== undefined || dq;
  const path = ready ? `/shops?q=${encodeURIComponent(dq)}${pos ? `&lat=${pos.lat.toFixed(4)}&lng=${pos.lng.toFixed(4)}` : ''}` : null;
  const { data } = useApi<{ shops: ShopListItem[] }>(path);
  const shops = data?.shops ?? [];
  const nearby = !dq && pos ? shops.filter((s) => s.distanceKm != null && s.distanceKm < 0.3).slice(0, 3) : [];
  const rest = shops.filter((s) => !nearby.includes(s));

  return (
    <Page title={title} subtitle={pos ? 'Yaqin do‘konlar birinchi' : undefined}>
      <SearchInput value={q} onChange={setQ} placeholder="Do'kon nomi…" />
      <div className="mt-3">
        {!data && <SkeletonList rows={6} />}
        {data && shops.length === 0 && (
          <EmptyState icon="shops" title="Topilmadi" action={<Button icon="plus" onClick={() => nav.push('shop-edit')}>Yangi do'kon</Button>} />
        )}
        {nearby.length > 0 && (
          <Section title="📍 Siz turgan joy" className="mt-0">
            <List className="ring-2 ring-brand">
              {nearby.map((s) => (
                <ShopRow key={s.id} s={s} onClick={() => onPick(s.id)} />
              ))}
            </List>
          </Section>
        )}
        {rest.length > 0 && (
          <Section title={nearby.length ? 'Boshqalar' : undefined} className={nearby.length ? '' : 'mt-0'}>
            <List>
              {rest.map((s) => (
                <ShopRow key={s.id} s={s} onClick={() => onPick(s.id)} />
              ))}
            </List>
          </Section>
        )}
      </div>
    </Page>
  );
}
