import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildCreditNoteQrText, renderCreditNotePdf, assertAcceptedCreditNote } from './creditNotePresentation';
import { presentationFixture } from './__fixtures__/creditNotePresentation';
describe('accepted credit note delivery', () => {
  it('contains the full official QR payload including CUDE and original fiscal identities', () => {
    const text = buildCreditNoteQrText(assertAcceptedCreditNote(presentationFixture));
    expect(text).toContain('NumFac: NC1');
    expect(text).toContain('ValTolFac: 266.00');
    expect(text).toContain('ValOtroIm: 16.00');
    expect(text).toContain('CUDE: ' + 'c'.repeat(96));
    expect(text).toContain('https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=');
  });
  it.each(['pending', 'rejected', 'error'])('never exposes %s as a fiscal representation', (state) => {
    expect(() => assertAcceptedCreditNote({ ...presentationFixture, dianDocument: { ...presentationFixture.dianDocument, state } })).toThrow('not_accepted');
  });
  it('rejects a cross-tenant document association', () => {
    expect(() => assertAcceptedCreditNote({ ...presentationFixture, dianDocument: { ...presentationFixture.dianDocument, restaurantId: 'other' } })).toThrow('incomplete_document');
  });
  it('creates a readable PDF and paginates a large note', async () => {
    const note = assertAcceptedCreditNote(presentationFixture);
    const pdf = await renderCreditNotePdf(note);
    expect(await renderCreditNotePdf(note)).toEqual(pdf);
    expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe('%PDF');
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    const large = { ...note, snapshot: { ...note.snapshot, lines: Array.from({ length: 70 }, () => note.snapshot.lines[0]) } };
    expect((await PDFDocument.load(await renderCreditNotePdf(large))).getPageCount()).toBeGreaterThan(2);
  });
});
