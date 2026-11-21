import { PdfBuilder, type Column } from './builder.ts';
import { formatMoney, formatNumber } from '../shared/money.ts';
import { formatQty, splitCans } from '../shared/qty.ts';
import { formatDate } from '../shared/dates.ts';
import { moneyToUzWords } from '../shared/uzwords.ts';
import { t } from '../shared/i18n/index.ts';

// All printable documents. Each function takes plain data and returns PDF bytes.

export interface BizInfo {
  name: string;
  phone: string;
  address: string;
  legalName: string;
  stir: string;
  bankName: string;
  mfo: string;
  bankAccount: string;
  logo?: { data: Uint8Array; type: string } | null;
}

export interface Party {
  name: string;
  legalName?: string | null;
  address?: string | null;
  phones?: string[];
  stir?: string | null;
  bankName?: string | null;
  mfo?: string | null;
  bankAccount?: string | null;
  contactName?: string | null;
}

export interface DocLine {
  flavour: string;
  qtyCans: number;
  packSize: number;
  pricePerPack: number;
  pricePerCan: number;
  isBonus: boolean;
  lineTotal: number;
}

const p = (k: string) => t(`pdf.${k}` as never);

async function start(title: string, biz: BizInfo) {
  const b = await PdfBuilder.create(title);
  await b.header({
    name: biz.legalName || biz.name,
    lines: [
      [biz.address, biz.phone && `${p('phone')}: ${biz.phone}`].filter(Boolean).join(' · '),
      biz.stir ? `${p('stir')}: ${biz.stir}${biz.bankName ? ` · ${p('bank')}: ${biz.bankName}` : ''}${biz.mfo ? ` · ${p('mfo')}: ${biz.mfo}` : ''}${biz.bankAccount ? ` · ${p('account')}: ${biz.bankAccount}` : ''}` : '',
    ],
    logo: biz.logo,
  });
  return b;
}

function partyBlock(b: PdfBuilder, x: number, w: number, label: string, party: Party) {
  b.text(label.toUpperCase(), { x, width: w, size: 8, bold: true, color: undefined });
  b.text(party.legalName || party.name, { x, width: w, size: 11, bold: true });
  if (party.legalName && party.legalName !== party.name) b.text(party.name, { x, width: w, size: 9 });
  if (party.contactName) b.text(party.contactName, { x, width: w, size: 9 });
  if (party.address) b.text(`${p('address')}: ${party.address}`, { x, width: w, size: 9 });
  if (party.phones?.length) b.text(`${p('phone')}: ${party.phones.join(', ')}`, { x, width: w, size: 9 });
  if (party.stir) b.text(`${p('stir')}: ${party.stir}`, { x, width: w, size: 9 });
  if (party.bankName) b.text(`${p('bank')}: ${party.bankName}${party.mfo ? `, ${p('mfo')}: ${party.mfo}` : ''}`, { x, width: w, size: 9 });
  if (party.bankAccount) b.text(`${p('account')}: ${party.bankAccount}`, { x, width: w, size: 9 });
}

function bizAsParty(biz: BizInfo): Party {
  return {
    name: biz.name,
    legalName: biz.legalName || null,
    address: biz.address,
    phones: biz.phone ? [biz.phone] : [],
    stir: biz.stir,
    bankName: biz.bankName,
    mfo: biz.mfo,
    bankAccount: biz.bankAccount,
  };
}

function linesTable(b: PdfBuilder, lines: DocLine[]) {
  const cols: Column[] = [
    { title: p('no'), width: 0.06, align: 'center' },
    { title: p('flavour'), width: 0.34 },
    { title: p('qty'), width: 0.2, align: 'right' },
    { title: p('price'), width: 0.2, align: 'right' },
    { title: p('sum'), width: 0.2, align: 'right' },
  ];
  b.table(
    cols,
    lines.map((l, i) => {
      const { cans } = splitCans(l.qtyCans, l.packSize);
      const price = l.isBonus ? p('bonus') : cans ? `${formatNumber(l.pricePerPack)} / blok\n${formatNumber(l.pricePerCan)} / dona` : formatNumber(l.pricePerPack);
      return [
        String(i + 1),
        l.isBonus ? { text: `${l.flavour} (${p('bonus')})`, bold: false } : l.flavour,
        formatQty(l.qtyCans, l.packSize),
        { text: price, muted: l.isBonus },
        l.isBonus ? { text: '0', muted: true } : formatNumber(l.lineTotal),
      ];
    }),
  );
}

export interface OrderDocData {
  kind: 'confirmation' | 'waybill';
  number: string;
  date: string;
  deliveryDate: string;
  business: BizInfo;
  shop: Party;
  lines: DocLine[];
  subtotal: number;
  discount: number;
  total: number;
  prevDebt?: number;
  paidNow?: number;
  newBalance?: number;
  comment?: string | null;
  revision?: number;
  revisionReason?: string | null;
}

export async function orderDocument(d: OrderDocData): Promise<Uint8Array> {
  const isWaybill = d.kind === 'waybill';
  const title = `${isWaybill ? p('waybill') : p('orderConfirmation')} № ${d.number}`;
  const b = await start(title, d.business);
  b.title(title, `${formatDate(d.date)}${d.revision ? ` · ${p('revision')} ${d.revision}` : ''}`);
  if (d.revision && d.revisionReason) b.text(`${p('reason')}: ${d.revisionReason}`, { size: 9, align: 'center' });
  b.columns(
    (bb, x, w) => partyBlock(bb, x, w, p('supplier'), bizAsParty(d.business)),
    (bb, x, w) => partyBlock(bb, x, w, p('customer'), d.shop),
  );
  b.space(8);
  if (!isWaybill) b.text(`${p('deliveryDate')}: ${formatDate(d.deliveryDate)}`, { size: 10, bold: true, gap: 4 });
  linesTable(b, d.lines);
  const totals: Parameters<PdfBuilder['totals']>[0] = [{ label: p('subtotal'), value: formatMoney(d.subtotal) }];
  if (d.discount) totals.push({ label: p('discount'), value: `-${formatMoney(d.discount)}` });
  totals.push({ label: p('total'), value: formatMoney(d.total), bold: true, color: 'brand' });
  b.totals(totals);
  b.text(`${p('inWords')}: ${moneyToUzWords(d.total)}`, { size: 9.5, gap: 6 });
  if (isWaybill && d.prevDebt !== undefined) {
    const more: Parameters<PdfBuilder['totals']>[0] = [{ label: p('prevDebt'), value: formatMoney(d.prevDebt) }];
    if (d.paidNow) more.push({ label: p('paidNow'), value: `-${formatMoney(d.paidNow)}` });
    more.push({ label: p('newBalance'), value: formatMoney(d.newBalance ?? 0), bold: true, color: (d.newBalance ?? 0) > 0 ? 'danger' : 'brand' });
    b.totals(more);
  }
  if (d.comment) b.text(`${t('common.comment')}: ${d.comment}`, { size: 9, gap: 4 });
  if (isWaybill) b.signatures(p('signFrom'), p('signTo'));
  return b.save();
}

export interface ReturnDocData {
  number: string;
  date: string;
  business: BizInfo;
  shop: Party;
  orderNumber?: string | null;
  lines: (DocLine & { condition: string })[];
  total: number;
  reason?: string | null;
  newBalance: number;
}

export async function returnDocument(d: ReturnDocData): Promise<Uint8Array> {
  const title = `${p('returnAct')} № ${d.number}`;
  const b = await start(title, d.business);
  b.title(title, formatDate(d.date));
  b.columns(
    (bb, x, w) => partyBlock(bb, x, w, p('customer'), d.shop),
    (bb, x, w) => partyBlock(bb, x, w, p('supplier'), bizAsParty(d.business)),
  );
  b.space(8);
  if (d.orderNumber) b.text(`${p('document')}: ${d.orderNumber}`, { size: 10, gap: 4 });
  b.table(
    [
      { title: p('no'), width: 0.06, align: 'center' },
      { title: p('flavour'), width: 0.3 },
      { title: p('condition'), width: 0.16 },
      { title: p('qty'), width: 0.16, align: 'right' },
      { title: p('price'), width: 0.14, align: 'right' },
      { title: p('sum'), width: 0.18, align: 'right' },
    ],
    d.lines.map((l, i) => [String(i + 1), l.flavour, t(`returnCondition.${l.condition}` as never), formatQty(l.qtyCans, l.packSize), formatNumber(l.pricePerCan) + ' / dona', formatNumber(l.lineTotal)]),
  );
  b.totals([
    { label: p('returnTotal'), value: formatMoney(d.total), bold: true, color: 'brand' },
    { label: p('newBalance'), value: formatMoney(d.newBalance) },
  ]);
  b.text(`${p('inWords')}: ${moneyToUzWords(d.total)}`, { size: 9.5, gap: 4 });
  if (d.reason) b.text(`${p('reason')}: ${d.reason}`, { size: 9.5 });
  b.signatures(p('signTo'), p('signFrom'));
  return b.save();
}

export interface ReconciliationData {
  number: string;
  date: string;
  from: string;
  to: string;
  business: BizInfo;
  shop: Party;
  opening: number;
  rows: { date: string; doc: string; debit: number; credit: number }[];
  closing: number;
}

export async function reconciliationDocument(d: ReconciliationData): Promise<Uint8Array> {
  const title = `${p('reconciliation')} № ${d.number}`;
  const b = await start(title, d.business);
  b.title(title, `${p('period')}: ${formatDate(d.from)} — ${formatDate(d.to)}`);
  b.columns(
    (bb, x, w) => partyBlock(bb, x, w, p('supplier'), bizAsParty(d.business)),
    (bb, x, w) => partyBlock(bb, x, w, p('customer'), d.shop),
  );
  b.space(8);
  const debitSum = d.rows.reduce((s, r) => s + r.debit, 0);
  const creditSum = d.rows.reduce((s, r) => s + r.credit, 0);
  b.table(
    [
      { title: t('common.date'), width: 0.16 },
      { title: p('document'), width: 0.36 },
      { title: p('debit'), width: 0.24, align: 'right' },
      { title: p('credit'), width: 0.24, align: 'right' },
    ],
    [
      [{ text: '', bold: true }, { text: p('opening'), bold: true }, { text: d.opening > 0 ? formatNumber(d.opening) : '', bold: true }, { text: d.opening < 0 ? formatNumber(-d.opening) : '', bold: true }],
      ...d.rows.map((r) => [formatDate(r.date), r.doc, r.debit ? formatNumber(r.debit) : '', r.credit ? formatNumber(r.credit) : '']),
      [{ text: '', bold: true }, { text: t('common.total'), bold: true }, { text: formatNumber(debitSum), bold: true }, { text: formatNumber(creditSum), bold: true }],
      [{ text: '', bold: true }, { text: p('closing'), bold: true }, { text: d.closing > 0 ? formatNumber(d.closing) : '', bold: true }, { text: d.closing < 0 ? formatNumber(-d.closing) : '', bold: true }],
    ],
  );
  b.text(
    d.closing >= 0 ? `${formatDate(d.to)} holatiga ${p('shopOwes').toLowerCase()}: ${formatMoney(d.closing)} (${moneyToUzWords(d.closing)})` : `${formatDate(d.to)} holatiga ${p('weOwe').toLowerCase()}: ${formatMoney(-d.closing)}`,
    { size: 10, bold: true, gap: 6 },
  );
  b.signatures(p('supplier'), p('customer'));
  return b.save();
}

export interface ReceiptData {
  number: string;
  date: string;
  business: BizInfo;
  shop: Party;
  amount: number;
  method: string;
  receivedBy: string;
  balanceAfter: number;
  comment?: string | null;
}

export async function receiptDocument(d: ReceiptData): Promise<Uint8Array> {
  const title = `${p('receipt')} № ${d.number}`;
  const b = await start(title, d.business);
  b.title(title, formatDate(d.date));
  b.text(`${p('customer')}: ${d.shop.legalName || d.shop.name}`, { size: 11, bold: true, gap: 6 });
  b.totals([
    { label: p('received'), value: formatMoney(d.amount), bold: true, color: 'brand' },
    { label: p('method'), value: t(`payMethod.${d.method}` as never) },
    { label: p('balanceAfter'), value: formatMoney(d.balanceAfter) },
  ]);
  b.text(`${p('inWords')}: ${moneyToUzWords(d.amount)}`, { size: 9.5, gap: 4 });
  if (d.comment) b.text(`${t('common.comment')}: ${d.comment}`, { size: 9.5 });
  b.text(`Qabul qildi: ${d.receivedBy}`, { size: 9.5 });
  b.signatures(p('supplier'), p('customer'));
  return b.save();
}

export interface SupplierOrderData {
  number: string;
  date: string;
  arrivalDate?: string | null;
  business: BizInfo;
  supplierName: string;
  lines: { flavour: string; packs: number; pricePerPack?: number }[];
  showPrices: boolean;
  comment?: string | null;
}

export async function supplierOrderDocument(d: SupplierOrderData): Promise<Uint8Array> {
  const title = `${p('supplierOrder')} № ${d.number}`;
  const b = await start(title, d.business);
  b.title(title, `${formatDate(d.date)}${d.arrivalDate ? ` · kerak: ${formatDate(d.arrivalDate)}` : ''}`);
  b.text(`${p('supplier')}: ${d.supplierName}`, { size: 11, bold: true, gap: 6 });
  const totalPacks = d.lines.reduce((s, l) => s + l.packs, 0);
  const cols: Column[] = d.showPrices
    ? [
        { title: p('no'), width: 0.08, align: 'center' },
        { title: p('flavour'), width: 0.42 },
        { title: p('packs'), width: 0.14, align: 'right' },
        { title: p('price'), width: 0.16, align: 'right' },
        { title: p('sum'), width: 0.2, align: 'right' },
      ]
    : [
        { title: p('no'), width: 0.1, align: 'center' },
        { title: p('flavour'), width: 0.6 },
        { title: p('packs'), width: 0.3, align: 'right' },
      ];
  b.table(
    cols,
    [
      ...d.lines.map((l, i) =>
        d.showPrices
          ? [String(i + 1), l.flavour, String(l.packs), formatNumber(l.pricePerPack ?? 0), formatNumber((l.pricePerPack ?? 0) * l.packs)]
          : [String(i + 1), l.flavour, String(l.packs)],
      ),
      d.showPrices
        ? ['', { text: t('common.total'), bold: true }, { text: String(totalPacks), bold: true }, '', { text: formatNumber(d.lines.reduce((s, l) => s + (l.pricePerPack ?? 0) * l.packs, 0)), bold: true }]
        : ['', { text: t('common.total'), bold: true }, { text: String(totalPacks), bold: true }],
    ],
    { size: 11 },
  );
  if (d.comment) b.text(`${t('common.comment')}: ${d.comment}`, { size: 10 });
  return b.save();
}

export interface ChecklistDocData {
  date: string;
  business: BizInfo;
  title: string;
  rows: { no: number; name: string; address: string; phone: string; debt: number; note: string }[];
  plannedKm?: number | null;
}

/** "Bugungi ro'yxat": shops in route order with empty tick boxes. */
export async function checklistDocument(d: ChecklistDocData): Promise<Uint8Array> {
  const b = await start(d.title, d.business);
  b.title(d.title, `${formatDate(d.date)} · ${d.rows.length} ta do'kon${d.plannedKm ? ` · ${Math.round(d.plannedKm)} km` : ''}`);
  b.table(
    [
      { title: '✓', width: 0.06, align: 'center' },
      { title: p('no'), width: 0.06, align: 'center' },
      { title: "Do'kon", width: 0.26 },
      { title: p('address'), width: 0.26 },
      { title: p('phone'), width: 0.17 },
      { title: 'Qarz', width: 0.19, align: 'right' },
    ],
    d.rows.map((r) => ['☐', String(r.no), r.note ? `${r.name}\n${r.note}` : r.name, r.address, r.phone, r.debt > 0 ? formatNumber(r.debt) : '—']),
    { size: 10 },
  );
  const total = d.rows.reduce((s, r) => s + Math.max(0, r.debt), 0);
  b.totals([{ label: "Yig'iladigan qarz", value: formatMoney(total), bold: true, color: 'brand' }]);
  return b.save();
}
