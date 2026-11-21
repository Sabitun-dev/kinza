import type { Ctx } from '../core/context.ts';
import type { DbOrTx, Tx } from '../core/db.ts';
import type { BlobStore } from '../core/files.ts';
import { saveFile, signFile } from '../core/files.ts';
import type { Settings } from '../core/settings.ts';
import type { Button } from '../core/notifier.ts';
import { esc } from '../core/notifier.ts';
import type { DocKind } from '../generated/prisma/enums.ts';
import { stampExistingPdf } from '../pdf/builder.ts';
import type { BizInfo, Party } from '../pdf/documents.ts';
import { t } from '../shared/i18n/index.ts';

export async function bizInfo(db: DbOrTx, blobs: BlobStore, s: Settings): Promise<BizInfo> {
  let logo: BizInfo['logo'] = null;
  if (s.logoFileId) {
    const f = await db.file.findUnique({ where: { id: s.logoFileId } });
    const data = f ? await blobs.get(f.key) : null;
    if (f && data) logo = { data, type: f.contentType };
  }
  return {
    name: s.businessName,
    phone: s.businessPhone,
    address: s.businessAddress,
    legalName: s.legalName,
    stir: s.stir,
    bankName: s.bankName,
    mfo: s.mfo,
    bankAccount: s.bankAccount,
    logo,
  };
}

export function shopParty(shop: {
  name: string;
  legalName: string | null;
  address: string | null;
  phones: string[];
  stir: string | null;
  bankName: string | null;
  mfo: string | null;
  bankAccount: string | null;
  contactName: string | null;
}): Party {
  return { ...shop };
}

/** Stores a generated PDF and its document row (inside the caller's transaction). */
export async function storeDocument(
  tx: Tx,
  ctx: Ctx,
  input: {
    kind: DocKind;
    bytes: Uint8Array;
    fileName: string;
    number?: string | null;
    revision?: number;
    orderId?: number;
    returnId?: number;
    shopId?: number;
    paymentId?: number;
    supplierOrderId?: number;
    periodFrom?: Date;
    periodTo?: Date;
  },
) {
  const file = await saveFile(tx, ctx.blobs, {
    kind: 'PDF',
    name: input.fileName,
    contentType: 'application/pdf',
    data: input.bytes,
    userId: ctx.user.id,
  });
  return tx.document.create({
    data: {
      kind: input.kind,
      number: input.number ?? null,
      revision: input.revision ?? 0,
      orderId: input.orderId,
      returnId: input.returnId,
      shopId: input.shopId,
      paymentId: input.paymentId,
      supplierOrderId: input.supplierOrderId,
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      fileId: file.id,
      createdById: ctx.user.id,
    },
  });
}

/** Voids documents and stamps their PDFs "BEKOR QILINGAN VERSIYA" (the file is kept). */
export async function voidDocuments(tx: Tx, blobs: BlobStore, where: { orderId?: number; kind: DocKind }, reason: string) {
  const docs = await tx.document.findMany({ where: { ...where, voidedAt: null }, include: { file: true } });
  for (const d of docs) {
    await tx.document.update({ where: { id: d.id }, data: { voidedAt: new Date(), voidReason: reason } });
    const bytes = await blobs.get(d.file.key);
    if (bytes) {
      try {
        await blobs.put(d.file.key, await stampExistingPdf(bytes, t('pdf.voided')), 'application/pdf');
      } catch (err) {
        console.error('Could not stamp voided PDF', d.id, err);
      }
    }
  }
  return docs.length;
}

/** Sends a stored document to a Telegram chat. Failures are logged, never thrown. */
export async function sendDocumentToChat(ctx: Pick<Ctx, 'db' | 'blobs' | 'notifier'>, documentId: number, chatId: number, caption: string, buttons?: Button[][]) {
  try {
    const doc = await ctx.db.document.findUnique({ where: { id: documentId }, include: { file: true } });
    if (!doc) return false;
    const data = await ctx.blobs.get(doc.file.key);
    if (!data) return false;
    await ctx.notifier.sendDocument(chatId, { name: doc.file.name, data }, caption, buttons);
    return true;
  } catch (err) {
    console.error('sendDocumentToChat failed', documentId, err);
    return false;
  }
}

/** Message to all active owners (used when an agent or driver does something important). */
export async function notifyOwners(ctx: Pick<Ctx, 'db' | 'notifier' | 'user'>, text: string, buttons?: Button[][], exceptSelf = true) {
  const owners = await ctx.db.user.findMany({ where: { role: 'OWNER', active: true } });
  for (const o of owners) {
    if (exceptSelf && o.id === ctx.user.id) continue;
    try {
      await ctx.notifier.sendMessage(Number(o.telegramId), text, buttons);
    } catch (err) {
      console.error('notifyOwners failed', err);
    }
  }
}

/** Public, time-limited link to a PDF (to share with a shop). */
export function publicFileUrl(settings: Settings, fileId: number, days = 30) {
  const base = (settings.appUrl || process.env.URL || '').replace(/\/+$/, '');
  return base + signFile(fileId, days * 86_400);
}

export { esc };
