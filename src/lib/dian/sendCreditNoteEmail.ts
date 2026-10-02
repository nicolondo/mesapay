import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { sendEmail } from '@/lib/mailer';
import { brandedInvoiceFrom } from '@/lib/simpleInvoice';
import { getEmailTranslator } from '@/lib/emailIntl';
import { formatMoney } from '@/lib/format';
import {
  loadAcceptedCreditNote, renderCreditNotePdf, creditNoteAttachedXml,
  creditNoteFileName, creditNotePublicUrl, CreditNoteDeliveryError,
} from './creditNotePresentation';

export type CreditNoteEmailOutcome =
  | { ok: true; to: string; emailedAt: string }
  | { ok: false; reason: string };
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Never changes fiscal status; all failures are sanitized and retryable separately. */
export async function sendDianCreditNoteEmail(
  creditNoteId: string,
  restaurantId: string,
  { force = false }: { force?: boolean } = {},
): Promise<CreditNoteEmailOutcome> {
  let documentId: string | undefined;
  let claim: string | undefined;
  try {
    const note = await loadAcceptedCreditNote(creditNoteId, restaurantId);
    const doc = note.dianDocument;
    documentId = doc.id;
    if (doc.emailedAt && !force) return { ok: false, reason: 'already_emailed' };
    const sendingAt = /^sending:(\d+)$/.exec(doc.emailError ?? '')?.[1];
    if (sendingAt && Date.now() - Number(sendingAt) < 5 * 60_000) return { ok: false, reason: 'email_in_progress' };
    // Persist the signed delivery container even when no recipient was requested.
    let xml: string;
    try { xml = await creditNoteAttachedXml(note); }
    catch {
      await db.dianDocument.updateMany({ where: { id: doc.id, restaurantId, state: 'accepted', emailError: doc.emailError }, data: { emailError: 'incomplete_document' } });
      return { ok: false, reason: 'incomplete_document' };
    }
    const recipient = note.snapshot.recipientEmail;
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      await db.dianDocument.updateMany({ where: { id: doc.id, restaurantId, state: 'accepted', emailError: doc.emailError }, data: { emailError: 'no_recipient' } });
      return { ok: false, reason: 'no_recipient' };
    }
    let pdf: Uint8Array;
    try { pdf = await renderCreditNotePdf(note); }
    catch {
      await db.dianDocument.updateMany({ where: { id: doc.id, restaurantId, state: 'accepted', emailError: doc.emailError }, data: { emailError: 'incomplete_document' } });
      return { ok: false, reason: 'incomplete_document' };
    }
    const { t, locale } = await getEmailTranslator(note.snapshot.locale, 'emailCreditNote');
    const url = creditNotePublicUrl(note.publicToken);
    const paragraphs = [t('intro'), t('reference', { number: note.snapshot.original.invoiceNumber }), t('total', { amount: formatMoney(note.totalCents, { locale, currency: 'COP', fractionDigits: 2 }) }), t('attachments')];
    const from = brandedInvoiceFrom(note.snapshot.brandName);
    claim = `sending:${Date.now()}`;
    const acquired = await db.dianDocument.updateMany({
      where: { id: doc.id, restaurantId, kind: 'credit_note', state: 'accepted', emailedAt: doc.emailedAt, emailError: doc.emailError },
      data: { emailError: claim },
    });
    if (!acquired.count) return { ok: false, reason: 'already_emailed' };
    // Stable payload and key permit safe retry after a provider timeout (Resend 24h window).
    const idempotencyKey = 'credit-note/' + createHash('sha256').update(`${doc.id}:${doc.emailedAt?.toISOString() ?? 'first'}`).digest('hex');
    const sent = await sendEmail({
      to: recipient, ...(from ? { from } : {}),
      subject: t('subject', { number: note.documentNumber, name: note.snapshot.brandName }),
      text: [...paragraphs, `${t('open')}: ${url}`].join('\n\n'),
      html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#262522"><h1>${escape(note.snapshot.brandName)}</h1>${paragraphs.map((p) => `<p>${escape(p)}</p>`).join('')}<p><a href="${escape(url)}">${escape(t('open'))}</a></p></div>`,
      attachments: [
        { filename: creditNoteFileName(note, 'pdf'), content: Buffer.from(pdf).toString('base64'), contentType: 'application/pdf' },
        { filename: creditNoteFileName(note, 'xml'), content: Buffer.from(xml).toString('base64'), contentType: 'application/xml' },
      ], idempotencyKey,
    });
    const at = new Date();
    await db.dianDocument.updateMany({
      where: { id: doc.id, restaurantId, state: 'accepted', emailError: claim },
      data: sent ? { emailedAt: at, emailError: null } : { emailError: 'send_failed' },
    });
    return sent ? { ok: true, to: recipient, emailedAt: at.toISOString() } : { ok: false, reason: 'send_failed' };
  } catch (error) {
    if (documentId && claim) {
      await db.dianDocument.updateMany({ where: { id: documentId, restaurantId, emailError: claim }, data: { emailError: 'send_failed' } }).catch(() => undefined);
    }
    return { ok: false, reason: error instanceof CreditNoteDeliveryError ? error.code : 'send_failed' };
  }
}
