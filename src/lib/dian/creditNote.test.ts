import { describe, expect, it } from 'vitest';
import { buildDianCreditNoteXml } from './creditNote';
import { computeCufe } from './crypto';
import { originalInvoiceInput } from './__fixtures__/creditNote';

const input = {
  ...originalInvoiceInput, invoiceNumber: 'NC1', prefix: 'NC',
  reference: { invoiceNumber: 'FE1', cufe: 'a'.repeat(96), issueDate: '2026-10-01' },
  discrepancyCode: '2' as const, discrepancyDescription: 'Anulación de factura electrónica',
};

describe('CreditNote DIAN 1.9', () => {
  it('uses the official CUDE vector including IVA/INC/ICA blocks (11.4.3)', () => {
    expect(computeCufe({ invoiceNumber: '8110007871', issueDate: '2019-01-12', issueTime: '07:00:00-05:00', lineExtensionAmount: '5000.00', taxIva: '950.00', taxInc: '0.00', taxIca: '0.00', payableAmount: '5950.00', supplierNit: '900373076', customerId: '8355990', key: '12301', environment: '1' }, 'cude')).toBe('907e4444decc9e59c160a2fb3b6659b33dc5b632a5008922b9a62f83f757b1c448e47f5867f2b50dbdb96f48c7681168');
  });
  it('includes mandatory extensions, parties, payment means, tax detail and reference', () => {
    const { xml } = buildDianCreditNoteXml(input);
    for (const tag of ['InvoiceSource', 'AuthorizationProvider', 'PaymentMeans', 'PartyTaxScheme', 'StandardItemIdentification', 'TaxSubtotal']) expect(xml).toContain(`:${tag}>`);
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="COP">200.00</cbc:TaxExclusiveAmount>');
    expect(xml).toContain('schemeID="1" schemeName="31"');
    expect(xml).toContain('<cbc:ID>NC</cbc:ID>');
    expect(xml).not.toContain('InvoiceControl');
    expect(xml).not.toContain('ReferenceID');
    expect(xml).toContain('<cbc:UUID schemeName="CUFE-SHA384">' + 'a'.repeat(96));
  });
  it('preserves the taxable base when a partial adjustment rounds tax to zero', () => {
    const { xml, totals } = buildDianCreditNoteXml({ ...input, lines: [{
      ...input.lines[0], quantity: 1, unitPriceCents: 1, lineTotalCents: 1, taxCents: 0,
    }] });
    expect(totals.taxableBaseCents).toBe(1);
    expect(xml).toContain('<cbc:TaxableAmount currencyID="COP">0.01</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:Percent>8.00</cbc:Percent>');
  });
  it('keeps the official reason in Description and places user explanation in Note', () => {
    const { xml } = buildDianCreditNoteXml({ ...input, discrepancyCode: '6', discrepancyDescription: 'Acuerdo & cliente' });
    expect(xml).toContain('<cbc:Description>Descuento comercial por volumen de ventas</cbc:Description>');
    expect(xml).toContain('<cbc:Note>Acuerdo &amp; cliente</cbc:Note>');
  });

  it('preserves the original invoice line ID in partial notes', () => {
    const { xml } = buildDianCreditNoteXml({ ...input, lines: [{ ...input.lines[0], originalLineId: '7' }] });
    expect(xml).toContain('<cac:CreditNoteLine><cbc:ID>1</cbc:ID>');
    expect(xml).toContain('<cbc:Note>Referencia a la línea original: 7</cbc:Note>');
  });

});
