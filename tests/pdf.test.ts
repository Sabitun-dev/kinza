import { describe, expect, it } from 'vitest';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import { loadFonts } from '../src/pdf/fonts.ts';
import { orderDocument, reconciliationDocument, returnDocument, type BizInfo } from '../src/pdf/documents.ts';
import { stampExistingPdf } from '../src/pdf/builder.ts';

const biz: BizInfo = {
  name: 'KINZA DISTRO',
  phone: '+998 90 000 00 00',
  address: 'Namangan',
  legalName: "O'g'il G'isht MChJ",
  stir: '123456789',
  bankName: 'Ipoteka bank',
  mfo: '00000',
  bankAccount: '20208000000000000001',
};

describe('PDF', () => {
  it('font has every Uzbek and Cyrillic letter we use', () => {
    const font = (fontkit as any).create(loadFonts().regular);
    for (const ch of "O'g'il G'isht ʻ ʼ Ш Ч Ў Қ Ғ Ҳ ш ч ў қ ғ ҳ so'm №") {
      if (ch === ' ') continue;
      expect(font.hasGlyphForCodePoint(ch.codePointAt(0)), `missing glyph ${ch}`).toBe(true);
    }
  });

  it('builds a nakladnoy with Uzbek text, many lines and a void stamp', async () => {
    const bytes = await orderDocument({
      kind: 'waybill',
      number: 'KD-2026-0001',
      date: '2026-11-21',
      deliveryDate: '2026-11-21',
      business: biz,
      shop: { name: "G'isht do'koni", address: 'Chust yo‘li', phones: ['+998901112233'], stir: '987654321', contactName: 'Шавкат Чориев' },
      lines: Array.from({ length: 40 }, (_, i) => ({
        flavour: i === 0 ? "O'g'il limon" : `Ta'm ${i}`,
        qtyCans: 54,
        packSize: 24,
        pricePerPack: 120_000,
        pricePerCan: 5_000,
        isBonus: i === 3,
        lineTotal: i === 3 ? 0 : 270_000,
      })),
      subtotal: 10_530_000,
      discount: 30_000,
      total: 10_500_000,
      prevDebt: 1_000_000,
      paidNow: 2_000_000,
      newBalance: 9_500_000,
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    const stamped = await stampExistingPdf(bytes, 'BEKOR QILINGAN VERSIYA');
    expect(stamped.byteLength).toBeGreaterThan(bytes.byteLength);
  });

  it('builds return and reconciliation documents', async () => {
    const r = await returnDocument({
      number: 'QD-2026-0001',
      date: '2026-11-21',
      business: biz,
      shop: { name: 'Baraka' },
      lines: [{ flavour: 'Limon', qtyCans: 6, packSize: 24, pricePerPack: 120_000, pricePerCan: 5_000, isBonus: false, lineTotal: 30_000, condition: 'DAMAGED' }],
      total: 30_000,
      newBalance: 100_000,
    });
    expect(r.byteLength).toBeGreaterThan(1000);
    const a = await reconciliationDocument({
      number: 'AS-2026-0001',
      date: '2026-11-21',
      from: '2026-11-01',
      to: '2026-11-21',
      business: biz,
      shop: { name: 'Baraka' },
      opening: 500_000,
      rows: [
        { date: '2026-11-05', doc: 'KD-2026-0001', debit: 400_000, credit: 0 },
        { date: '2026-11-10', doc: "To'lov", debit: 0, credit: 700_000 },
      ],
      closing: 200_000,
    });
    expect(a.byteLength).toBeGreaterThan(1000);
  });
});
