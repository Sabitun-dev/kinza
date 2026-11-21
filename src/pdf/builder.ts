import { PDFDocument, rgb, degrees, type PDFFont, type PDFPage, type PDFImage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadFonts } from './fonts.ts';

// A4 in points
export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const MARGIN = 40;
export const CONTENT_W = PAGE_W - MARGIN * 2;

const INK = rgb(0.06, 0.15, 0.1);
const MUTED = rgb(0.36, 0.43, 0.39);
const LINE = rgb(0.8, 0.85, 0.82);
const BRAND = rgb(0.06, 0.36, 0.23);
const HEAD_BG = rgb(0.9, 0.95, 0.92);

export interface Column {
  title: string;
  width: number; // fraction of content width
  align?: 'left' | 'right' | 'center';
}

/** Small layout helper over pdf-lib: text with wrapping, tables with page breaks, header. */
export class PdfBuilder {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];

  private constructor(
    public doc: PDFDocument,
    public font: PDFFont,
    public bold: PDFFont,
  ) {}

  static async create(title: string) {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const f = loadFonts();
    const font = await doc.embedFont(f.regular, { subset: true });
    const bold = await doc.embedFont(f.bold, { subset: true });
    doc.setTitle(title);
    doc.setProducer('KINZA DISTRO');
    doc.setCreator('KINZA DISTRO');
    const b = new PdfBuilder(doc, font, bold);
    b.addPage();
    return b;
  }

  addPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN + 20) this.addPage();
  }

  width(text: string, size: number, bold = false) {
    return (bold ? this.bold : this.font).widthOfTextAtSize(text, size);
  }

  /** Splits text into lines that fit maxWidth. */
  wrap(text: string, size: number, maxWidth: number, bold = false): string[] {
    const out: string[] = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (this.width(next, size, bold) <= maxWidth || !line) line = next;
        else {
          out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  }

  /** Draws text at the cursor (or at x) and moves the cursor down. */
  text(
    text: string,
    opts: { x?: number; size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; width?: number; align?: 'left' | 'right' | 'center'; gap?: number; move?: boolean } = {},
  ) {
    const size = opts.size ?? 10;
    const x0 = opts.x ?? MARGIN;
    const w = opts.width ?? CONTENT_W - (x0 - MARGIN);
    const lines = this.wrap(text, size, w, opts.bold);
    const lh = size * 1.3;
    this.ensure(lh * lines.length);
    let y = this.y;
    for (const line of lines) {
      const tw = this.width(line, size, opts.bold);
      const x = opts.align === 'right' ? x0 + w - tw : opts.align === 'center' ? x0 + (w - tw) / 2 : x0;
      this.page.drawText(line, { x, y: y - size, size, font: opts.bold ? this.bold : this.font, color: opts.color ?? INK });
      y -= lh;
    }
    const h = lh * lines.length + (opts.gap ?? 0);
    if (opts.move !== false) this.y -= h;
    return h;
  }

  space(h: number) {
    this.y -= h;
  }

  hr(color = LINE) {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.7, color });
    this.y -= 6;
  }

  /** Two blocks side by side (e.g. supplier | customer). Returns the taller height. */
  columns(left: (b: PdfBuilder, x: number, w: number) => void, right: (b: PdfBuilder, x: number, w: number) => void) {
    const startY = this.y;
    const half = CONTENT_W / 2 - 8;
    left(this, MARGIN, half);
    const leftY = this.y;
    this.y = startY;
    right(this, MARGIN + half + 16, half);
    this.y = Math.min(leftY, this.y);
  }

  table(cols: Column[], rows: (string | { text: string; bold?: boolean; muted?: boolean })[][], opts: { size?: number } = {}) {
    const size = opts.size ?? 9.5;
    const widths = cols.map((c) => c.width * CONTENT_W);
    const pad = 4;
    const drawRow = (cells: (string | { text: string; bold?: boolean; muted?: boolean })[], header: boolean) => {
      const prepared = cells.map((c, i) => {
        const cell = typeof c === 'string' ? { text: c } : c;
        return { ...cell, lines: this.wrap(cell.text, size, widths[i] - pad * 2, header || cell.bold) };
      });
      const h = Math.max(...prepared.map((p) => p.lines.length)) * size * 1.3 + pad * 2;
      if (this.y - h < MARGIN + 20) {
        this.addPage();
        if (!header) drawRow(cols.map((c) => c.title), true);
      }
      let x = MARGIN;
      if (header) this.page.drawRectangle({ x, y: this.y - h, width: CONTENT_W, height: h, color: HEAD_BG });
      prepared.forEach((p, i) => {
        const w = widths[i];
        let ty = this.y - pad;
        for (const line of p.lines) {
          const font = header || p.bold ? this.bold : this.font;
          const tw = font.widthOfTextAtSize(line, size);
          const align = cols[i].align ?? 'left';
          const tx = align === 'right' ? x + w - pad - tw : align === 'center' ? x + (w - tw) / 2 : x + pad;
          this.page.drawText(line, { x: tx, y: ty - size, size, font, color: p.muted ? MUTED : INK });
          ty -= size * 1.3;
        }
        this.page.drawRectangle({ x, y: this.y - h, width: w, height: h, borderColor: LINE, borderWidth: 0.6 });
        x += w;
      });
      this.y -= h;
    };
    drawRow(cols.map((c) => c.title), true);
    for (const r of rows) drawRow(r, false);
    this.y -= 6;
  }

  /** Label: value lines aligned to the right edge (totals block). */
  totals(items: { label: string; value: string; bold?: boolean; color?: 'brand' | 'danger' }[]) {
    for (const it of items) {
      this.ensure(16);
      const size = it.bold ? 11 : 10;
      const font = it.bold ? this.bold : this.font;
      const vw = font.widthOfTextAtSize(it.value, size);
      const color = it.color === 'brand' ? BRAND : it.color === 'danger' ? rgb(0.75, 0.15, 0.15) : INK;
      this.page.drawText(it.label, { x: PAGE_W - MARGIN - 260, y: this.y - size, size, font, color: MUTED });
      this.page.drawText(it.value, { x: PAGE_W - MARGIN - vw, y: this.y - size, size, font, color });
      this.y -= size * 1.6;
    }
  }

  signatures(left: string, right: string) {
    this.ensure(70);
    this.space(30);
    const half = CONTENT_W / 2 - 20;
    for (const [i, label] of [left, right].entries()) {
      const x = MARGIN + i * (half + 40);
      this.page.drawLine({ start: { x, y: this.y }, end: { x: x + half, y: this.y }, thickness: 0.7, color: INK });
      this.page.drawText(label, { x, y: this.y - 12, size: 9, font: this.font, color: MUTED });
      this.page.drawText('(imzo, F.I.Sh.)', { x, y: this.y - 24, size: 8, font: this.font, color: MUTED });
    }
    this.y -= 34;
  }

  /** Business header with optional logo on the right. */
  async header(biz: { name: string; lines: string[]; logo?: { data: Uint8Array; type: string } | null }) {
    let logo: PDFImage | null = null;
    if (biz.logo) {
      try {
        logo = biz.logo.type.includes('png') ? await this.doc.embedPng(biz.logo.data) : await this.doc.embedJpg(biz.logo.data);
      } catch {
        logo = null;
      }
    }
    const top = this.y;
    const textW = logo ? CONTENT_W - 90 : CONTENT_W;
    this.text(biz.name, { size: 16, bold: true, color: BRAND, width: textW });
    for (const l of biz.lines) if (l) this.text(l, { size: 9, color: MUTED, width: textW });
    if (logo) {
      const s = Math.min(70 / logo.width, 60 / logo.height);
      this.page.drawImage(logo, { x: PAGE_W - MARGIN - logo.width * s, y: top - logo.height * s, width: logo.width * s, height: logo.height * s });
      this.y = Math.min(this.y, top - logo.height * s);
    }
    this.space(6);
    this.hr(BRAND);
    this.space(4);
  }

  title(text: string, sub?: string) {
    this.text(text, { size: 14, bold: true, align: 'center' });
    if (sub) this.text(sub, { size: 10, align: 'center', color: MUTED });
    this.space(8);
  }

  /** Big diagonal stamp on every page (e.g. "BEKOR QILINGAN VERSIYA"). */
  stamp(text: string) {
    stampPages(this.pages, this.bold, text);
  }

  async save(): Promise<Uint8Array> {
    // Page numbers
    const n = this.pages.length;
    if (n > 1) {
      this.pages.forEach((p, i) => {
        const s = `${i + 1} / ${n}`;
        p.drawText(s, { x: PAGE_W - MARGIN - this.font.widthOfTextAtSize(s, 8), y: 20, size: 8, font: this.font, color: MUTED });
      });
    }
    return this.doc.save();
  }
}

function stampPages(pages: PDFPage[], font: PDFFont, text: string) {
  for (const p of pages) {
    const size = 40;
    const w = font.widthOfTextAtSize(text, size);
    p.drawText(text, {
      x: PAGE_W / 2 - (w / 2) * Math.cos(Math.PI / 6),
      y: PAGE_H / 2 - (w / 2) * Math.sin(Math.PI / 6),
      size,
      font,
      color: rgb(0.8, 0.1, 0.1),
      opacity: 0.35,
      rotate: degrees(30),
    });
  }
}

/** Marks an existing PDF as void (used for replaced revisions). */
export async function stampExistingPdf(bytes: Uint8Array, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  doc.registerFontkit(fontkit);
  const bold = await doc.embedFont(loadFonts().bold, { subset: true });
  stampPages(doc.getPages(), bold, text);
  return doc.save();
}
