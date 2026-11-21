import { useMemo, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, Chip, Chips, EmptyState, ErrorBox, Money, Qty, SearchInput, Skeleton, cx } from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { useApi } from '../../api';
import { useNav } from '../../nav';
import { useRole } from '../../session';
import { t } from '@shared/i18n';
import { formatDate } from '@shared/dates';

export interface ProductItem {
  id: number;
  name: string;
  flavour: string;
  packSize: number;
  photoUrl: string | null;
  archived: boolean;
  barcode: string | null;
  buyPricePerPack?: number;
  minPricePerPack?: number;
  minPricePerCan?: number;
  prices?: { perPack: number; perCan: number; groups: Record<string, { perPack: number; perCan: number } | null> };
  stock: { inStock: number; reserved: number; available: number; damaged: number; nearestExpiry: string | null; low: boolean; stockValue?: number };
}

/** Ombor: every flavour with photo, price and available stock. */
export function StockTab() {
  const nav = useNav();
  const role = useRole();
  const { data, error, reload } = useApi<{ products: ProductItem[] }>('/products');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | 'order'>('all');
  const products = useMemo(() => {
    let list = data?.products ?? [];
    if (q) list = list.filter((p) => `${p.name} ${p.flavour} ${p.barcode ?? ''}`.toLowerCase().includes(q.toLowerCase()));
    if (filter === 'low') list = list.filter((p) => p.stock.low);
    if (filter === 'order') list = list.filter((p) => p.stock.available < 0);
    return list;
  }, [data, q, filter]);
  const totalValue = data?.products.reduce((s, p) => s + (p.stock.stockValue ?? 0), 0);

  return (
    <Page title={t('tabs.stock')} subtitle={role === 'OWNER' && totalValue ? `Ombor qiymati: ${totalValue.toLocaleString('ru-RU').replace(/,/g, ' ')} so'm` : undefined}>
      {role !== 'AGENT' && (
        <div className="grid grid-cols-2 gap-2">
          {role === 'OWNER' && (
            <Button size="md" variant="primary" icon="truck" onClick={() => nav.push('supplier-proposal')}>
              Toshkentga
            </Button>
          )}
          <Button size="md" variant="soft" icon="layers" onClick={() => nav.push('supplier-orders')}>
            Qabul qilish
          </Button>
          {role === 'OWNER' && (
            <>
              <Button size="md" variant="secondary" icon="scale" onClick={() => nav.push('stock-count')}>
                Inventarizatsiya
              </Button>
              <Button size="md" variant="secondary" icon="refresh" onClick={() => nav.push('stock-adjust')}>
                Hisobdan chiqarish
              </Button>
            </>
          )}
        </div>
      )}
      {role !== 'AGENT' && (
        <button className="mt-2 flex h-11 w-full items-center justify-center gap-2 text-[15px] font-semibold text-brand" onClick={() => nav.push('batches')}>
          <Icon name="clock" size={18} /> Partiyalar va yaroqlilik muddatlari
        </button>
      )}
      <div className="mt-2">
        <SearchInput value={q} onChange={setQ} placeholder="Ta'm yoki shtrix-kod…" />
      </div>
      <Chips className="mt-3">
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
          {t('common.all')}
        </Chip>
        <Chip active={filter === 'low'} onClick={() => setFilter('low')} tone="warn">
          Kam qolgan
        </Chip>
        <Chip active={filter === 'order'} onClick={() => setFilter('order')} tone="danger">
          Yetishmaydi
        </Chip>
      </Chips>
      <div className="mt-3">
        {error && <ErrorBox error={error} onRetry={reload} />}
        {!data && !error && (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[210px]" />
            ))}
          </div>
        )}
        {data && data.products.length === 0 && (
          <EmptyState
            icon="stock"
            title="Mahsulot yo'q"
            text={role === 'OWNER' ? "Avval Kinza ta'mlarini qo'shing." : undefined}
            action={role === 'OWNER' ? <Button icon="plus" onClick={() => nav.push('product-edit')}>Mahsulot qo'shish</Button> : undefined}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          {products.map((p) => (
            <ProductCard key={p.id} p={p} onClick={() => nav.push('product', { id: p.id })} />
          ))}
        </div>
      </div>
    </Page>
  );
}

export function ProductPhoto({ p, className }: { p: { photoUrl: string | null; flavour: string }; className?: string }) {
  return p.photoUrl ? (
    <img src={p.photoUrl} alt="" loading="lazy" className={cx('object-cover', className)} />
  ) : (
    <div className={cx('flex items-center justify-center bg-brand-soft text-[26px] font-bold text-brand', className)}>{p.flavour.slice(0, 1)}</div>
  );
}

function ProductCard({ p, onClick }: { p: ProductItem; onClick: () => void }) {
  const a = p.stock.available;
  return (
    <Card padded={false} onClick={onClick} className="overflow-hidden">
      <ProductPhoto p={p} className="aspect-[4/3] w-full" />
      <div className="p-3">
        <div className="truncate text-[16px] font-bold">{p.flavour}</div>
        {p.prices && <Money value={p.prices.perPack} className="text-[14px] text-muted" />}
        <div className={cx('mt-1.5 text-[15px] font-semibold', a < 0 ? 'text-danger' : p.stock.low ? 'text-warn' : 'text-ok')}>
          <Qty cans={a} packSize={p.packSize} />
        </div>
        <div className="text-[12px] text-muted">
          {p.stock.reserved > 0 ? `band: ${Math.round(p.stock.reserved / p.packSize)} blok` : 'mavjud'}
        </div>
        {p.stock.nearestExpiry && (
          <div className="mt-1">
            <Badge tone="warn">
              <Icon name="clock" size={12} /> {formatDate(p.stock.nearestExpiry)}
            </Badge>
          </div>
        )}
      </div>
    </Card>
  );
}
