import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import QRCode from 'qrcode';
import { db } from '@/lib/db';
import { getEmailTranslator } from '@/lib/emailIntl';
import { formatMoney } from '@/lib/format';
import { dianIssueDateTime } from './dianDateTime';
import { centsToDianAmount, dianQrUrl } from './crypto';
import { loadDianConfig, resolveEmisor } from './config';
import { buildSignedCreditNoteContainer } from './creditNoteContainer';
import { extractApplicationResponse, unzipFirstXml, zipInvoice } from './soap';
import type { CreditNoteSnapshot } from './creditNotes/types';

export type DeliveryNote = {
  id: string; restaurantId: string; publicToken: string; documentNumber: string;
  reasonCode: string; reasonText: string; subtotalCents: number; taxCents: number; totalCents: number;
  abandonedAt: Date | null; snapshot: unknown;
  dianDocument: null | {
    id: string; restaurantId: string; creditNoteId: string | null; kind: string; state: string;
    cufe: string | null; issuedAt: Date | null; xmlZip: Uint8Array | null; responseXml: string | null;
    emailedAt: Date | null; emailError: string | null; deliveryXml?: string | null;
  };
};
export type AcceptedCreditNote = Omit<DeliveryNote, 'snapshot' | 'dianDocument'> & {
  snapshot: CreditNoteSnapshot;
  dianDocument: NonNullable<DeliveryNote['dianDocument']> & {
    cufe: string; issuedAt: Date; xmlZip: Uint8Array; responseXml: string;
  };
};
export class CreditNoteDeliveryError extends Error {
  constructor(readonly code: 'not_found' | 'not_accepted' | 'incomplete_document') { super(code); }
}
export function assertAcceptedCreditNote(note: DeliveryNote | null): AcceptedCreditNote {
  if (!note) throw new CreditNoteDeliveryError('not_found');
  const doc = note.dianDocument;
  if (!doc || doc.state !== 'accepted' || note.abandonedAt) throw new CreditNoteDeliveryError('not_accepted');
  const snap = note.snapshot as CreditNoteSnapshot;
  if (doc.restaurantId !== note.restaurantId || doc.creditNoteId !== note.id || doc.kind !== 'credit_note' ||
      !doc.cufe || !/^[a-f\d]{96}$/i.test(doc.cufe) || !doc.issuedAt || !doc.xmlZip || !doc.responseXml ||
      snap?.version !== 1 || !snap.original?.supplier || !snap.original?.customer || !snap.lines?.length) {
    throw new CreditNoteDeliveryError('incomplete_document');
  }
  return note as AcceptedCreditNote;
}
export async function loadAcceptedCreditNote(id: string, restaurantId: string): Promise<AcceptedCreditNote> {
  return assertAcceptedCreditNote(await db.creditNote.findFirst({
    where: { id, restaurantId }, include: { dianDocument: true },
  }));
}
export async function loadPublicCreditNote(token: string): Promise<AcceptedCreditNote> {
  if (!/^[a-zA-Z0-9_-]{20,128}$/.test(token)) throw new CreditNoteDeliveryError('not_found');
  return assertAcceptedCreditNote(await db.creditNote.findFirst({
    where: { publicToken: token, abandonedAt: null, dianDocument: { is: { state: 'accepted', kind: 'credit_note' } } },
    include: { dianDocument: true },
  }));
}
export function creditNotePublicUrl(token: string): string {
  const base = process.env.APP_PUBLIC_BASE_URL ?? 'https://mesapay.co';
  return `${base.replace(/\/$/, '')}/nota-credito/${encodeURIComponent(token)}`;
}
export function creditNoteFileName(note: AcceptedCreditNote, extension: string): string {
  return `${note.documentNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}.${extension}`;
}
export function buildCreditNoteQrText(note: AcceptedCreditNote): string {
  const { original, lines } = note.snapshot;
  const issued = dianIssueDateTime(note.dianDocument.issuedAt);
  const iva = lines.filter((line) => line.taxSchemeId === '01').reduce((sum, line) => sum + line.taxCents, 0);
  const other = lines.filter((line) => line.taxSchemeId !== '01').reduce((sum, line) => sum + line.taxCents, 0);
  return [
    `NumFac: ${note.documentNumber}`, `FecFac: ${issued.date}`, `HorFac: ${issued.time}`,
    `NitFac: ${original.supplier.companyId}`, `DocAdq: ${original.customer.companyId}`,
    `ValFac: ${centsToDianAmount(note.subtotalCents)}`, `ValIva: ${centsToDianAmount(iva)}`,
    `ValOtroIm: ${centsToDianAmount(other)}`, `ValTolFac: ${centsToDianAmount(note.totalCents)}`,
    `CUDE: ${note.dianDocument.cufe}`, dianQrUrl(note.dianDocument.cufe, original.environment),
  ].join('\n');
}
export async function creditNoteQrPng(note: AcceptedCreditNote): Promise<Buffer> {
  return QRCode.toBuffer(buildCreditNoteQrText(note), { type: 'png', width: 480, margin: 2, errorCorrectionLevel: 'M' });
}

/** Only accepted XML plus the actual DIAN ApplicationResponse may be delivered. */
export async function creditNoteAttachedXml(note: AcceptedCreditNote): Promise<string> {
  if (note.dianDocument.deliveryXml) return note.dianDocument.deliveryXml;
  const stored = await db.dianDocument.findFirst({
    where: { id: note.dianDocument.id, restaurantId: note.restaurantId, kind: 'credit_note', state: 'accepted' },
    select: { deliveryXml: true },
  });
  if (stored?.deliveryXml) return stored.deliveryXml;
  const [xml, response] = await Promise.all([
    unzipFirstXml(note.dianDocument.xmlZip), extractApplicationResponse(note.dianDocument.responseXml),
  ]);
  if (!xml || !response) throw new CreditNoteDeliveryError('incomplete_document');
  const [config, issuer] = await Promise.all([
    loadDianConfig(note.restaurantId, { requireTechnicalKey: false }), resolveEmisor(note.restaurantId),
  ]);
  if (issuer?.taxId?.split('-')[0].replace(/\D/g, '') !== note.snapshot.original.supplier.companyId ||
      (config.environment === 'produccion' ? '1' : '2') !== note.snapshot.original.environment) {
    throw new CreditNoteDeliveryError('incomplete_document');
  }
  const signed = buildSignedCreditNoteContainer(note, xml, response, config.cert);
  const won = await db.dianDocument.updateMany({
    where: { id: note.dianDocument.id, restaurantId: note.restaurantId, kind: 'credit_note', state: 'accepted', deliveryXml: null },
    data: { deliveryXml: signed },
  });
  if (won.count === 1) return signed;
  const winner = await db.dianDocument.findFirst({
    where: { id: note.dianDocument.id, restaurantId: note.restaurantId, state: 'accepted' }, select: { deliveryXml: true },
  });
  if (!winner?.deliveryXml) throw new CreditNoteDeliveryError('incomplete_document');
  return winner.deliveryXml;
}
export async function creditNoteDeliveryZip(note: AcceptedCreditNote): Promise<Buffer> {
  return zipInvoice(creditNoteFileName(note, 'xml'), await creditNoteAttachedXml(note));
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const output: string[] = [];
  for (const paragraph of text.replace(/[\r\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line && font.widthOfTextAtSize(line + ' ' + word, size) > width) { output.push(line); line = ''; }
      for (const char of (line ? ' ' : '') + word) {
        if (font.widthOfTextAtSize(line + char, size) > width) { output.push(line); line = ''; }
        line += char;
      }
    }
    output.push(line);
  }
  return output;
}
export async function renderCreditNotePdf(note: AcceptedCreditNote): Promise<Uint8Array> {
  const { t, locale } = await getEmailTranslator(note.snapshot.locale, 'creditNotePresentation');
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regularBytes, boldBytes, qrBytes] = await Promise.all([
    readFile(path.join(process.cwd(), 'public/fonts/noto-sans-latin-400-normal.woff')),
    readFile(path.join(process.cwd(), 'public/fonts/noto-sans-latin-600-normal.woff')),
    creditNoteQrPng(note),
  ]);
  const regular = await pdf.embedFont(regularBytes, { subset: true });
  const bold = await pdf.embedFont(boldBytes, { subset: true });
  const qr = await pdf.embedPng(qrBytes);
  const ink = rgb(0.12, 0.13, 0.14), grey = rgb(0.4, 0.42, 0.43);
  const left = 42, width = 511, bottom = 165;
  let page: PDFPage;
  let y = 0;
  const newPage = () => {
    page = pdf.addPage([595, 842]);
    page.drawText(note.snapshot.brandName, { x: left, y: 800, size: 11, font: bold, color: ink });
    page.drawText(note.documentNumber, { x: 430, y: 800, size: 11, font: bold, color: ink });
    page.drawLine({ start: { x: left, y: 785 }, end: { x: 553, y: 785 }, color: rgb(0.84, 0.84, 0.83), thickness: 0.6 });
    y = 758;
  };
  const paragraph = (value: string, size = 10, font = regular, color = ink, gap = 5) => {
    for (const line of wrap(value, font, size, width)) {
      if (y < bottom + size) newPage();
      page.drawText(line, { x: left, y, size, font, color });
      y -= size * 1.5;
    }
    y -= gap;
  };
  const money = (value: number) => formatMoney(value, { currency: 'COP', locale, fractionDigits: 2 });
  const { original, lines } = note.snapshot;
  const issued = dianIssueDateTime(note.dianDocument.issuedAt);
  newPage();
  paragraph(t('title'), 22, bold, ink, 2);
  if (original.environment === '2') paragraph(t('testEnvironment'), 10, bold, grey, 6);
  paragraph(`${t('accepted')}  ·  ${t('issued')}: ${issued.date} ${issued.time}`, 9, regular, grey, 12);
  for (const [label, party] of [[t('issuer'), original.supplier], [t('customer'), original.customer]] as const) {
    paragraph(`${label}: ${party.name}`, 10, bold, ink, 0);
    paragraph(`${party.idSchemeName === '31' ? 'NIT' : party.idSchemeName === '13' ? 'CC' : party.idSchemeName === '22' ? 'CE' : t('passport')} ${party.companyId}${party.dv ? '-' + party.dv : ''}${party.email ? '  ·  ' + party.email : ''}`, 9, regular, grey, 0);
    if (party.address) paragraph(`${party.address.line} · ${party.address.cityName}, ${party.address.deptName}`, 9, regular, grey, 1);
    if (party.phone) paragraph(party.phone, 9, regular, grey, 0);
    y -= 6;
  }
  paragraph(`${t('originalInvoice')}: ${original.invoiceNumber}  ·  ${original.issueDate}`, 10, bold, ink, 0);
  paragraph(`${t('originalCufe')}: ${original.cufe}`, 7, regular, grey, 8);
  paragraph(`${t('reason')}: ${t(`reason${note.reasonCode}`)}`, 10, bold, ink, 1);
  paragraph(note.reasonText, 9, regular, grey, 12);
  paragraph(t('details'), 12, bold, ink, 6);
  for (const line of lines) {
    if (y < bottom + 65) newPage();
    paragraph(`${t('line', { id: line.originalLineId })} · ${line.description}`, 10, bold, ink, 0);
    paragraph(`${t('quantity')}: ${line.quantity}    ${t('unitPrice')}: ${money(line.unitPriceCents)}`, 9, regular, grey, 0);
    paragraph(`${t('base')}: ${money(line.lineTotalCents)}    ${line.taxSchemeId === '01' ? t('iva') : t('inc')} ${line.taxPct}%: ${money(line.taxCents)}    ${t('total')}: ${money(line.grossCents)}`, 9, regular, grey, 8);
  }
  if (y < bottom + 110) newPage();
  y -= 4;
  paragraph(`${t('subtotal')}: ${money(note.subtotalCents)}`, 10, regular, ink, 0);
  const iva = lines.filter((line) => line.taxSchemeId === '01').reduce((sum, line) => sum + line.taxCents, 0);
  const inc = lines.filter((line) => line.taxSchemeId === '04').reduce((sum, line) => sum + line.taxCents, 0);
  if (iva) paragraph(`${t('iva')}: ${money(iva)}`, 10, regular, ink, 0);
  if (inc) paragraph(`${t('inc')}: ${money(inc)}`, 10, regular, ink, 0);
  y -= 8;
  paragraph(`${t('total')}: ${money(note.totalCents)}`, 17, bold, ink, 0);
  paragraph(t('currency'), 8, regular, grey);
  const pages = pdf.getPages();
  for (const [index, p] of pages.entries()) {
    p.drawLine({ start: { x: left, y: 150 }, end: { x: 553, y: 150 }, color: rgb(0.8, 0.8, 0.8), thickness: 0.6 });
    p.drawImage(qr, { x: left, y: 44, width: 94, height: 94 });
    let fy = 129;
    for (const value of ['CUDE', note.dianDocument.cufe, t('fiscalNotice')]) {
      for (const line of wrap(value, regular, 7, 400)) {
        p.drawText(line, { x: 150, y: fy, size: 7, font: regular, color: grey }); fy -= 10;
      }
      fy -= 5;
    }
    p.drawText(t('page', { page: index + 1, total: pages.length }), { x: 450, y: 25, size: 8, font: regular, color: grey });
  }
  pdf.setCreationDate(note.dianDocument.issuedAt);
  pdf.setModificationDate(note.dianDocument.issuedAt);
  pdf.setTitle(`${t('title')} ${note.documentNumber}`);
  pdf.setAuthor(note.snapshot.original.supplier.name);
  return pdf.save();
}
