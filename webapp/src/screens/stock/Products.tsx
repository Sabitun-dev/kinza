import { useEffect, useState } from 'react';
import { Page } from '../../ui/page';
import { Badge, Button, Card, EmptyState, Field, IconButton, List, Money, MoneyInput, NumberInput, Qty, Row, Section, Skeleton, SkeletonList, TextInput, Toggle } from '../../ui/kit';
import { PhotoPicker } from '../../ui/photo';
import { api, invalidate, useApi } from '../../api';
import { useMainButton } from '../../mainButton';
import { useNav } from '../../nav';
import { useIsOwner, useSession } from '../../session';
import { toast } from '../../ui/toast';
import { confirmDialog, scanQr, supports } from '../../tg';
import { ProductPhoto, type ProductItem } from './StockTab';
import { ago, formatDate } from '../../util';
import { t } from '@shared/i18n';
import { formatMoney } from '@shared/money';

/** Owner: all products incl. archived. */
export function ProductsScreen() {
  const nav = useNav();
  const [archived, setArchived] = useState(false);
  const { data } = useApi<{ products: ProductItem[] }>(`/products${archived ? '?archived=1' : ''}`);
  return (
    <Page title="Mahsulotlar" right={<IconButton icon="plus" label="Qo'shish" tone="brand" onClick={() => nav.push('product-edit')} />}>
      <List className="mb-3">
        <Toggle label="Arxivdagilarni ham ko'rsatish" checked={archived} onChange={setArchived} />
      </List>
      {!data ? (
        <SkeletonList />
      ) : data.products.length === 0 ? (
        <EmptyState icon="stock" title="Mahsulot yo'q" action={<Button icon="plus" onClick={() => nav.push('product-edit')}>Qo'shish</Button>} />
      ) : (
        <List>
          {data.products.map((p) => (
            <Row
              key={p.id}
              left={<ProductPhoto p={p} className="h-12 w-12 rounded-[12px]" />}
              title={`${p.name} ${p.flavour}`}
              subtitle={`${formatMoney(p.prices?.perPack ?? 0)} · ${p.packSize} dona`}
              right={p.archived ? <Badge tone="grey">arxiv</Badge> : undefined}
              onClick={() => nav.push('product', { id: p.id })}
            />
          ))}
        </List>
      )}
    </Page>
  );
}

export function ProductDetail({ id }: { id: number }) {
  const nav = useNav();
  const owner = useIsOwner();
  const { data } = useApi<any>(`/products/${id}`);
  const moves = useApi<any>(`/stock/movements?productId=${id}`);
  if (!data) {
    return (
      <Page title="Mahsulot">
        <Skeleton className="h-60" />
      </Page>
    );
  }
  const { product: p, stock: s, priceHistory } = data;
  return (
    <Page title={p.flavour} subtitle={p.name} right={owner ? <IconButton icon="edit" label="Tahrirlash" onClick={() => nav.push('product-edit', { id })} /> : undefined}>
      <ProductPhoto p={p} className="aspect-[16/9] w-full rounded-[18px]" />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Card>
          <div className="text-[13px] text-muted">Omborda</div>
          <div className="text-[19px] font-bold"><Qty cans={s.inStock} packSize={p.packSize} /></div>
        </Card>
        <Card>
          <div className="text-[13px] text-muted">Band (tasdiqlangan)</div>
          <div className="text-[19px] font-bold"><Qty cans={s.reserved} packSize={p.packSize} /></div>
        </Card>
        <Card>
          <div className="text-[13px] text-muted">Mavjud</div>
          <div className={`text-[19px] font-bold ${s.available < 0 ? 'text-danger' : 'text-ok'}`}><Qty cans={s.available} packSize={p.packSize} /></div>
        </Card>
        <Card>
          <div className="text-[13px] text-muted">Shikastlangan</div>
          <div className="text-[19px] font-bold"><Qty cans={s.damaged} packSize={p.packSize} /></div>
        </Card>
      </div>
      {s.nearestExpiry && <Card className="mt-3 bg-warn-soft text-warn">Eng yaqin yaroqlilik muddati: <b>{formatDate(s.nearestExpiry)}</b></Card>}

      {moves.data?.movements?.length > 0 && (
        <Section title="Harakatlar">
          <List>
            {moves.data.movements.map((m: any) => (
              <Row
                key={m.id}
                title={<span className={m.qtyCans > 0 ? 'text-ok' : ''}>{m.qtyCans > 0 ? '+' : ''}<Qty cans={m.qtyCans} packSize={p.packSize} /></span>}
                subtitle={`${t(`movementType.${m.type}` as never)}${m.pool === 'DAMAGED' ? ' (shikastlangan)' : ''}${m.shopName ? ' · ' + m.shopName : ''}${m.reason ? ' · ' + m.reason : ''}`}
                right={<span className="text-[13px] text-muted">{ago(m.createdAt)}</span>}
              />
            ))}
          </List>
        </Section>
      )}

      {owner && priceHistory.length > 0 && (
        <Section title="Narxlar tarixi">
          <List>
            {priceHistory.map((h: any) => (
              <Row key={h.id} title={`${formatMoney(h.perPack)} / blok · ${formatMoney(h.perCan)} / dona`} subtitle={`${h.group} · ${ago(h.validFrom)}${h.changedBy ? ' · ' + h.changedBy : ''}`} />
            ))}
          </List>
        </Section>
      )}
    </Page>
  );
}

export function ProductEdit({ id }: { id?: number }) {
  const nav = useNav();
  const { settings } = useSession();
  const existing = useApi<any>(id ? `/products/${id}` : null);
  const list = useApi<{ products: ProductItem[]; groups: { id: number; name: string }[] }>('/products?archived=1');
  const [f, setF] = useState<Record<string, any>>({ name: 'Kinza', flavour: '', packSize: settings.defaultPackSize, groupPrices: {} });
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [canTouched, setCanTouched] = useState(false);

  useEffect(() => {
    if (!id || !existing.data || !list.data) return;
    const p = existing.data.product;
    const li = list.data.products.find((x) => x.id === id);
    setF({
      name: p.name,
      flavour: p.flavour,
      packSize: p.packSize,
      buyPricePerPack: p.buyPricePerPack,
      minPricePerPack: p.minPricePerPack,
      barcode: p.barcode ?? '',
      photoFileId: p.photoFileId,
      perPack: li?.prices?.perPack ?? null,
      perCan: li?.prices?.perCan ?? null,
      groupPrices: Object.fromEntries(Object.entries(li?.prices?.groups ?? {}).map(([g, v]) => [g, v?.perPack ?? null])),
      archived: !!p.archivedAt,
    });
    setPhotoUrl(p.photoUrl);
    setCanTouched(true);
  }, [id, existing.data, list.data]);

  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const packSize = f.packSize || 24;

  useMainButton({
    text: t('common.save'),
    disabled: !f.flavour?.trim() || !f.perPack,
    progress: saving,
    onClick: async () => {
      setSaving(true);
      try {
        const payload = {
          name: f.name || 'Kinza',
          flavour: f.flavour.trim(),
          packSize,
          buyPricePerPack: f.buyPricePerPack ?? 0,
          minPricePerPack: f.minPricePerPack ?? 0,
          barcode: f.barcode || null,
          photoFileId: f.photoFileId ?? null,
          price: { perPack: f.perPack, perCan: f.perCan ?? Math.round(f.perPack / packSize) },
          groupPrices: Object.entries(f.groupPrices as Record<string, number | null>).map(([g, v]) => ({ groupId: Number(g), perPack: v })),
        };
        if (id) await api.patch(`/products/${id}`, payload);
        else await api.post('/products', payload);
        invalidate('/products', '/pricing');
        toast(t('common.saved'));
        nav.pop();
      } catch (e) {
        toast.error(e);
      } finally {
        setSaving(false);
      }
    },
  });

  if (id && (!existing.data || !list.data)) {
    return (
      <Page title="Mahsulot">
        <Skeleton className="h-96" />
      </Page>
    );
  }
  const landed = f.buyPricePerPack ? f.buyPricePerPack : 0;
  const margin = f.perPack && landed ? f.perPack - landed : null;

  return (
    <Page title={id ? 'Tahrirlash' : 'Yangi mahsulot'}>
      <div className="space-y-4">
        <div className="flex gap-4">
          <PhotoPicker kind="PRODUCT_PHOTO" url={photoUrl} onUploaded={(p) => (set('photoFileId', p.id), setPhotoUrl(p.url))} />
          <div className="flex-1 space-y-3">
            <Field label="Mahsulot">
              <TextInput value={f.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
          </div>
        </div>
        <Field label="Ta'm *">
          <TextInput value={f.flavour} onChange={(e) => set('flavour', e.target.value)} placeholder="Masalan: Limon" autoFocus={!id} />
        </Field>
        <Field label="Blokda nechta dona">
          <NumberInput value={f.packSize} onChange={(v) => set('packSize', v ?? 24)} suffix="dona" min={1} />
        </Field>

        <Section title="Sotish narxi (asosiy)">
          <div className="space-y-3">
            <Field label="1 blok narxi *">
              <MoneyInput
                value={f.perPack ?? null}
                onChange={(v) => setF((x) => ({ ...x, perPack: v, perCan: canTouched ? x.perCan : v ? Math.round(v / packSize) : null }))}
              />
            </Field>
            <Field label="1 dona narxi" hint={f.perPack ? `Blok ÷ ${packSize} = ${formatMoney(Math.round(f.perPack / packSize))}` : undefined}>
              <MoneyInput value={f.perCan ?? null} onChange={(v) => (setCanTouched(true), set('perCan', v))} />
            </Field>
            <Field label="Eng past narx (blok)" hint="Agent bundan arzon sota olmaydi">
              <MoneyInput value={f.minPricePerPack ?? null} onChange={(v) => set('minPricePerPack', v)} />
            </Field>
          </div>
        </Section>

        {(list.data?.groups.length ?? 0) > 0 && (
          <Section title="Guruh narxlari (blok)">
            <div className="space-y-3">
              {list.data!.groups.map((g) => (
                <Field key={g.id} label={g.name} hint="Bo'sh = asosiy narx">
                  <MoneyInput value={f.groupPrices[g.id] ?? null} onChange={(v) => set('groupPrices', { ...f.groupPrices, [g.id]: v })} placeholder="—" />
                </Field>
              ))}
            </div>
          </Section>
        )}

        <Section title="Kirim narxi (faqat siz ko'rasiz)">
          <Field label="Toshkentdan olish narxi (blok)" hint={margin != null ? `Ustama: ${formatMoney(margin)} / blok (yo'l xarajatisiz)` : undefined}>
            <MoneyInput value={f.buyPricePerPack ?? null} onChange={(v) => set('buyPricePerPack', v)} />
          </Field>
        </Section>

        <Field label="Shtrix-kod (ixtiyoriy)">
          <div className="flex gap-2">
            <TextInput value={f.barcode ?? ''} onChange={(e) => set('barcode', e.target.value)} inputMode="numeric" />
            {supports.qr && (
              <Button
                variant="soft"
                icon="qr"
                onClick={async () => {
                  const v = await scanQr('Shtrix-kodni skanerlang');
                  if (v) set('barcode', v);
                }}
              >
                {''}
              </Button>
            )}
          </div>
        </Field>

        {id && (
          <Button
            block
            variant={f.archived ? 'soft' : 'danger'}
            icon="archive"
            onClick={async () => {
              if (!f.archived && !(await confirmDialog("Mahsulotni arxivlaysizmi? Eski hujjatlar o'zgarmaydi."))) return;
              await api.post(`/products/${id}/archive`, { archived: !f.archived });
              invalidate('/products');
              toast(t('common.done'));
              nav.pop();
            }}
          >
            {f.archived ? 'Arxivdan chiqarish' : 'Arxivlash'}
          </Button>
        )}
        <div className="h-4" />
      </div>
    </Page>
  );
}
