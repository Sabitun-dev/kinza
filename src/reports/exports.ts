import type { Ctx } from '../core/context.ts';
import { debtors } from '../domain/payments.ts';
import { stockLevels } from '../domain/stockLevels.ts';
import { addDays, fromDbDate, localDate, startOfLocalDay, toDbDate } from '../shared/dates.ts';
import { t } from '../shared/i18n/index.ts';

export type ExportKind = 'sales' | 'debts' | 'stock' | 'payments' | 'expenses' | 'supplier';

export interface Column {
  header: string;
  key: string;
  type: 'text' | 'money' | 'int' | 'num' | 'date';
  width?: number;
}

export interface Table {
  title: string;
  columns: Column[];
  rows: Record<string, string | number | null>[];
}

/** Builds the rows for one export (owner only — includes costs). */
export async function buildExport(ctx: Ctx, kind: ExportKind, from: string, to: string): Promise<Table> {
  const start = startOfLocalDay(from);
  const end = startOfLocalDay(addDays(to, 1));
  switch (kind) {
    case 'sales': {
      const items = await ctx.db.orderItem.findMany({
        where: { order: { status: 'DELIVERED', isOpening: false, deliveredAt: { gte: start, lt: end } } },
        include: { product: true, order: { include: { shop: true, agent: true, documents: { where: { kind: 'WAYBILL', voidedAt: null } } } } },
        orderBy: [{ order: { deliveredAt: 'asc' } }, { sortOrder: 'asc' }],
      });
      return {
        title: 'Sotuvlar',
        columns: [
          { header: 'Sana', key: 'date', type: 'date', width: 12 },
          { header: 'Yuk xati', key: 'doc', type: 'text', width: 16 },
          { header: "Do'kon", key: 'shop', type: 'text', width: 28 },
          { header: 'Agent', key: 'agent', type: 'text', width: 16 },
          { header: "Ta'm", key: 'flavour', type: 'text', width: 18 },
          { header: 'Bonus', key: 'bonus', type: 'text', width: 8 },
          { header: 'Dona', key: 'cans', type: 'int', width: 10 },
          { header: 'Blok', key: 'packs', type: 'num', width: 10 },
          { header: 'Narx (blok)', key: 'price', type: 'money', width: 14 },
          { header: 'Summa', key: 'sum', type: 'money', width: 14 },
          { header: 'Tannarx', key: 'cost', type: 'money', width: 14 },
          { header: 'Yalpi foyda', key: 'profit', type: 'money', width: 14 },
        ],
        rows: items.map((i) => ({
          date: localDate(i.order.deliveredAt!),
          doc: i.order.documents[0]?.number ?? i.order.number,
          shop: i.order.shop.name,
          agent: i.order.agent?.name ?? '',
          flavour: i.product.flavour,
          bonus: i.isBonus ? 'ha' : '',
          cans: i.qtyCans,
          packs: Math.round((i.qtyCans / i.packSize) * 100) / 100,
          price: i.pricePerPack,
          sum: i.lineTotal,
          cost: i.costTotal,
          profit: i.lineTotal - i.costTotal,
        })),
      };
    }
    case 'debts': {
      const d = await debtors(ctx, {});
      return {
        title: 'Qarzdorlar',
        columns: [
          { header: "Do'kon", key: 'shop', type: 'text', width: 28 },
          { header: 'Telefon', key: 'phone', type: 'text', width: 16 },
          { header: 'Agent', key: 'agent', type: 'text', width: 16 },
          { header: 'Qarz', key: 'balance', type: 'money', width: 14 },
          { header: "Muddati o'tgan", key: 'overdue', type: 'money', width: 14 },
          { header: '0–7 kun', key: 'b0', type: 'money', width: 13 },
          { header: '8–30 kun', key: 'b8', type: 'money', width: 13 },
          { header: '30+ kun', key: 'b30', type: 'money', width: 13 },
          { header: 'Eng eski (kun)', key: 'age', type: 'int', width: 12 },
        ],
        rows: d.rows.map((r) => ({ shop: r.name, phone: r.phones[0] ?? '', agent: r.agentName ?? '', balance: r.balance, overdue: r.overdue, b0: r.buckets.b0, b8: r.buckets.b8, b30: r.buckets.b30, age: r.ageDays })),
      };
    }
    case 'stock': {
      const products = await ctx.db.product.findMany({ orderBy: [{ sortOrder: 'asc' }, { flavour: 'asc' }] });
      const levels = await stockLevels(ctx.db, products.map((p) => p.id));
      return {
        title: 'Ombor',
        columns: [
          { header: "Ta'm", key: 'flavour', type: 'text', width: 20 },
          { header: 'Omborda (dona)', key: 'inStock', type: 'int', width: 14 },
          { header: 'Band (dona)', key: 'reserved', type: 'int', width: 12 },
          { header: 'Mavjud (dona)', key: 'available', type: 'int', width: 13 },
          { header: 'Mavjud (blok)', key: 'availablePacks', type: 'num', width: 13 },
          { header: 'Shikastlangan', key: 'damaged', type: 'int', width: 13 },
          { header: 'Eng yaqin muddat', key: 'expiry', type: 'date', width: 15 },
          { header: 'Qiymati (tannarx)', key: 'value', type: 'money', width: 16 },
        ],
        rows: products.map((p) => {
          const l = levels.get(p.id)!;
          return { flavour: p.flavour, inStock: l.inStock, reserved: l.reserved, available: l.available, availablePacks: Math.round((l.available / p.packSize) * 100) / 100, damaged: l.damaged, expiry: l.nearestExpiry, value: l.stockValue };
        }),
      };
    }
    case 'payments': {
      const pays = await ctx.db.payment.findMany({ where: { voidedAt: null, paidAt: { gte: start, lt: end } }, include: { shop: true, receivedBy: true, targetOrder: true }, orderBy: { paidAt: 'asc' } });
      return {
        title: "To'lovlar",
        columns: [
          { header: 'Sana', key: 'date', type: 'date', width: 12 },
          { header: "Do'kon", key: 'shop', type: 'text', width: 28 },
          { header: 'Summa', key: 'amount', type: 'money', width: 14 },
          { header: 'Turi', key: 'method', type: 'text', width: 12 },
          { header: 'Qabul qildi', key: 'by', type: 'text', width: 16 },
          { header: 'Hujjat', key: 'doc', type: 'text', width: 14 },
          { header: 'Topshirilgan', key: 'handed', type: 'text', width: 12 },
          { header: 'Izoh', key: 'comment', type: 'text', width: 24 },
        ],
        rows: pays.map((p) => ({
          date: localDate(p.paidAt),
          shop: p.shop.name,
          amount: p.amount,
          method: t(`payMethod.${p.method}` as never),
          by: p.receivedBy.name,
          doc: p.targetOrder?.number ?? '',
          handed: p.handedOverAt ? 'ha' : "yo'q",
          comment: p.comment ?? '',
        })),
      };
    }
    case 'expenses': {
      const ex = await ctx.db.expense.findMany({ where: { voidedAt: null, date: { gte: toDbDate(from), lte: toDbDate(to) } }, include: { category: true }, orderBy: { date: 'asc' } });
      return {
        title: 'Xarajatlar',
        columns: [
          { header: 'Sana', key: 'date', type: 'date', width: 12 },
          { header: 'Turi', key: 'category', type: 'text', width: 16 },
          { header: 'Summa', key: 'amount', type: 'money', width: 14 },
          { header: 'Izoh', key: 'comment', type: 'text', width: 30 },
        ],
        rows: ex.map((e) => ({ date: fromDbDate(e.date), category: e.category.name, amount: e.amount, comment: e.comment ?? '' })),
      };
    }
    case 'supplier': {
      const sos = await ctx.db.supplierOrder.findMany({ where: { createdAt: { gte: start, lt: end } }, include: { items: { include: { product: true } }, costs: true, payments: { where: { voidedAt: null } } }, orderBy: { createdAt: 'asc' } });
      return {
        title: 'Toshkent buyurtmalari',
        columns: [
          { header: 'Raqam', key: 'number', type: 'text', width: 13 },
          { header: 'Holati', key: 'status', type: 'text', width: 16 },
          { header: "Ta'm", key: 'flavour', type: 'text', width: 18 },
          { header: 'Buyurtma (blok)', key: 'ordered', type: 'int', width: 14 },
          { header: 'Keldi (dona)', key: 'received', type: 'int', width: 12 },
          { header: 'Shikast (dona)', key: 'damaged', type: 'int', width: 12 },
          { header: 'Narx (blok)', key: 'price', type: 'money', width: 13 },
          { header: 'Muddat', key: 'expiry', type: 'date', width: 12 },
          { header: 'Hisob summasi', key: 'invoice', type: 'money', width: 15 },
          { header: "Yo'l xarajati", key: 'cargo', type: 'money', width: 14 },
          { header: "To'langan", key: 'paid', type: 'money', width: 14 },
        ],
        rows: sos.flatMap((so) =>
          so.items.map((i, k) => ({
            number: so.number,
            status: t(`supplierStatus.${so.status}` as never),
            flavour: i.product.flavour,
            ordered: i.orderedPacks,
            received: i.receivedCans,
            damaged: i.damagedCans,
            price: i.buyPricePerPack,
            expiry: fromDbDate(i.expiry),
            invoice: k === 0 ? so.invoiceAmount : null,
            cargo: k === 0 ? so.costs.reduce((s, c) => s + c.amount, 0) : null,
            paid: k === 0 ? so.payments.reduce((s, p) => s + p.amount, 0) : null,
          })),
        ),
      };
    }
  }
}

/** CSV for Excel: UTF-8 with BOM, ";" separator (Excel in uz/ru locale opens it directly). */
export function toCsv(table: Table): Uint8Array {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [table.columns.map((c) => esc(c.header)).join(';'), ...table.rows.map((r) => table.columns.map((c) => esc(r[c.key])).join(';'))];
  return new TextEncoder().encode('﻿' + lines.join('\r\n'));
}

export async function toXlsx(table: Table, meta: { business: string; period: string }): Promise<Uint8Array> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.business;
  const ws = wb.addWorksheet(table.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.addRow([`${meta.business} — ${table.title}`]).font = { bold: true, size: 14, color: { argb: 'FF0F5D3A' } };
  ws.addRow([meta.period]).font = { color: { argb: 'FF5B6F64' } };
  const header = ws.addRow(table.columns.map((c) => c.header));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F1E9' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF0F5D3A' } } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  table.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.width ?? 14;
    if (c.type === 'money' || c.type === 'int') col.numFmt = '# ##0';
    if (c.type === 'num') col.numFmt = '# ##0.00';
  });
  for (const r of table.rows) {
    ws.addRow(table.columns.map((c) => (c.type === 'date' && r[c.key] ? new Date(String(r[c.key]) + 'T00:00:00Z') : r[c.key])));
  }
  table.columns.forEach((c, i) => {
    if (c.type === 'date') ws.getColumn(i + 1).numFmt = 'dd.mm.yyyy';
  });
  // Totals row for money columns
  if (table.rows.length) {
    const totals = table.columns.map((c, i) => {
      if (i === 0) return 'Jami';
      if (c.type !== 'money') return null;
      return table.rows.reduce((s, r) => s + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0);
    });
    ws.addRow(totals).font = { bold: true };
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
