import { originalInvoiceInput } from './creditNote';
import { buildDianInvoiceXml } from '../ubl';
import { parseAcceptedInvoiceXml } from '../creditNoteSource';
const original = { ...parseAcceptedInvoiceXml(buildDianInvoiceXml(originalInvoiceInput).xml), documentId: 'original-document' };
export const presentationFixture = {
  id: 'credit-id', restaurantId: 'restaurant-id', publicToken: 'random-public-token',
  documentNumber: 'NC1', reasonCode: '2', reasonText: 'Error en la factura original',
  subtotalCents: 25000, taxCents: 1600, totalCents: 26600, abandonedAt: null,
  snapshot: { version: 1 as const, originalDocumentId: original.documentId, original,
    lines: original.lines.map((line) => ({ ...line, originalLineId: line.lineId })),
    locale: 'es', recipientEmail: 'customer@example.test', brandName: 'Restaurante & Café' },
  dianDocument: { id: 'document-id', restaurantId: 'restaurant-id', creditNoteId: 'credit-id', kind: 'credit_note', state: 'accepted', cufe: 'c'.repeat(96), issuedAt: new Date('2026-10-02T15:00:00Z'), xmlZip: Buffer.from('zip'), responseXml: '<response/>', emailedAt: null, emailError: null },
};
