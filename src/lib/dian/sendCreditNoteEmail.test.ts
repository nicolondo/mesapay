import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), update: vi.fn(), send: vi.fn(), pdf: vi.fn(), xml: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { dianDocument: { updateMany: mocks.update } } }));
vi.mock('@/lib/mailer', () => ({ sendEmail: mocks.send }));
vi.mock('@/lib/simpleInvoice', () => ({ brandedInvoiceFrom: () => null }));
vi.mock('./creditNotePresentation', () => ({
  loadAcceptedCreditNote: mocks.load, renderCreditNotePdf: mocks.pdf, creditNoteAttachedXml: mocks.xml,
  creditNoteFileName: (_n: unknown, ext: string) => `NC1.${ext}`,
  creditNotePublicUrl: () => 'https://mesapay.co/nota-credito/token',
  CreditNoteDeliveryError: class extends Error { code = 'not_accepted'; },
}));
import { sendDianCreditNoteEmail } from './sendCreditNoteEmail';
const note = {
  documentNumber: 'NC1', totalCents: 10000,
  snapshot: { locale: 'es', recipientEmail: 'customer@example.test', brandName: '<Restaurante>', original: { invoiceNumber: 'FE1' } },
  dianDocument: { id: 'doc', emailedAt: null, emailError: null },
};
beforeEach(() => {
  vi.clearAllMocks(); mocks.load.mockResolvedValue(note); mocks.update.mockResolvedValue({ count: 1 });
  mocks.send.mockResolvedValue(true); mocks.pdf.mockResolvedValue(Buffer.from('%PDF')); mocks.xml.mockResolvedValue('<AttachedDocument/>');
});
describe('credit-note recipient email', () => {
  it('sends immutable recipient/locale with PDF and XML attachments', async () => {
    expect(await sendDianCreditNoteEmail('nc', 'tenant')).toMatchObject({ ok: true, to: 'customer@example.test' });
    expect(mocks.load).toHaveBeenCalledWith('nc', 'tenant');
    const args = mocks.send.mock.calls[0][0];
    expect(args.attachments.map((a: { filename: string }) => a.filename)).toEqual(['NC1.pdf', 'NC1.xml']);
    expect(args.html).not.toContain('<Restaurante>');
    expect(args.idempotencyKey).toContain('credit-note/');
    expect(mocks.update.mock.calls[0][0].where).toMatchObject({ restaurantId: 'tenant', state: 'accepted', emailedAt: null });
  });
  it('does not send twice when the claim is lost', async () => {
    mocks.update.mockResolvedValue({ count: 0 });
    expect(await sendDianCreditNoteEmail('nc', 'tenant')).toMatchObject({ ok: false, reason: 'already_emailed' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('does not send accepted-but-incomplete documents', async () => {
    mocks.xml.mockRejectedValue(new Error('bad xml'));
    expect(await sendDianCreditNoteEmail('nc', 'tenant')).toMatchObject({ ok: false, reason: 'incomplete_document' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('preserves previous success on failed forced resend', async () => {
    const earlier = new Date('2026-01-01');
    mocks.load.mockResolvedValue({ ...note, dianDocument: { ...note.dianDocument, emailedAt: earlier } });
    mocks.send.mockResolvedValue(false);
    expect(await sendDianCreditNoteEmail('nc', 'tenant', { force: true })).toMatchObject({ ok: false, reason: 'send_failed' });
    expect(mocks.update.mock.calls.at(-1)![0].data).toEqual({ emailError: 'send_failed' });
  });
  it('blocks another send while a lease is active, including force', async () => {
    mocks.load.mockResolvedValue({ ...note, dianDocument: { ...note.dianDocument, emailError: `sending:${Date.now()}` } });
    expect(await sendDianCreditNoteEmail('nc', 'tenant', { force: true })).toMatchObject({ ok: false, reason: 'email_in_progress' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('records a missing immutable recipient without looking up current contacts', async () => {
    mocks.load.mockResolvedValue({ ...note, snapshot: { ...note.snapshot, recipientEmail: null } });
    expect(await sendDianCreditNoteEmail('nc', 'tenant')).toMatchObject({ ok: false, reason: 'no_recipient' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
