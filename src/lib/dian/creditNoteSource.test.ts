import { describe, expect, it } from 'vitest';
import { buildDianInvoiceXml } from './ubl';
import { originalInvoiceInput } from './__fixtures__/creditNote';
import { parseAcceptedInvoiceXml } from './creditNoteSource';
import { saleLines } from './discountedLines';
import { buildDianCreditNoteXml } from './creditNote';
import { buildProposal, remainingLines } from './creditNotes/domain';

const xml = () => buildDianInvoiceXml(originalInvoiceInput).xml;

describe('immutable accepted invoice source', () => {
  it('reads original fiscal parties, lines, tax bases and totals without current DB data', () => {
    const source = parseAcceptedInvoiceXml(xml());
    expect(source.invoiceNumber).toBe('FE1');
    expect(source.supplier).toEqual(originalInvoiceInput.supplier);
    expect(source.lines[0]).toMatchObject({ ...originalInvoiceInput.lines[0], lineId: '1', grossCents: 21600 });
    expect(source.totals).toMatchObject({ lineExtensionCents: 25000, taxableBaseCents: 20000, taxIncCents: 1600, payableCents: 26600 });
  });
  it('retains customer fiscal contact/address and multiple IVA rates', () => {
    const source = parseAcceptedInvoiceXml(buildDianInvoiceXml({
      ...originalInvoiceInput,
      customer: { ...originalInvoiceInput.supplier, phone: '3001234567' },
      lines: [
        { ...originalInvoiceInput.lines[0], quantity: 1, unitPriceCents: 10000, lineTotalCents: 10000, taxCents: 1900, taxPct: '19.00', taxSchemeId: '01' },
        { ...originalInvoiceInput.lines[1], taxCents: 250, taxPct: '5.00', taxSchemeId: '01' },
      ],
    }).xml);
    expect(source.customer).toEqual({ ...originalInvoiceInput.supplier, phone: '3001234567' });
    expect(source.totals.taxIvaCents).toBe(2150);
    expect(source.lines.map((line) => line.taxPct)).toEqual(['19.00', '5.00']);
  });
  it('sums document taxes from independently rounded lines', () => {
    const source = parseAcceptedInvoiceXml(buildDianInvoiceXml({
      ...originalInvoiceInput,
      lines: Array.from({ length: 100 }, () => ({
        ...originalInvoiceInput.lines[0], quantity: 1, unitPriceCents: 6,
        lineTotalCents: 6, taxCents: 1, taxPct: '19.00', taxSchemeId: '01' as const,
      })),
    }).xml);
    expect(source.totals).toMatchObject({ lineExtensionCents: 600, taxIvaCents: 100, payableCents: 700 });
  });
  it.each([
    ['currency', (s: string) => s.replace('>COP</cbc:DocumentCurrencyCode>', '>USD</cbc:DocumentCurrencyCode>')],
    ['document allowance', (s: string) => s.replace('<cac:LegalMonetaryTotal>', '<cac:AllowanceCharge/><cac:LegalMonetaryTotal>')],
    ['total mismatch', (s: string) => s.replace('266.00</cbc:PayableAmount>', '267.00</cbc:PayableAmount>')],
    ['duplicate ID', (s: string) => s.replace('<cbc:ID>2</cbc:ID>', '<cbc:ID>1</cbc:ID>')],
    ['unknown tax', (s: string) => s.replaceAll('<cbc:ID>04</cbc:ID>', '<cbc:ID>03</cbc:ID>')],
    ['DOCTYPE', (s: string) => '<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + s],
    ['wrong environment', (s: string) => s.replace('<cbc:ProfileExecutionID>2', '<cbc:ProfileExecutionID>1')],
    ['not Invoice', (s: string) => s.replaceAll('Invoice xmlns=', 'CreditNote xmlns=')],
    ['invalid date', (s: string) => s.replaceAll('2026-10-02', '2026-02-31')],
    ['invalid time', (s: string) => s.replaceAll('10:00:00-05:00', '25:00:00-05:00')],
    ['line allowance', (s: string) => s.replace('<cac:Price>', '<cac:AllowanceCharge/><cac:Price>')],
    ['withholding', (s: string) => s.replace('<cac:LegalMonetaryTotal>', '<cac:WithholdingTaxTotal/><cac:LegalMonetaryTotal>')],
    ['unsafe value', (s: string) => s.replaceAll('200.00', '9007199254740991000.00')],
    ['negative value', (s: string) => s.replaceAll('200.00', '-200.00')],
    ['fractional cent', (s: string) => s.replaceAll('200.00', '200.001')],
    ['changed tax rate', (s: string) => s.replaceAll('8.00</cbc:Percent>', '19.00</cbc:Percent>')],
    ['line count', (s: string) => s.replace('<cbc:LineCountNumeric>2', '<cbc:LineCountNumeric>3')],
    ['fiscal party conflict', (s: string) => s.replace('<cac:PartyLegalEntity><cbc:RegistrationName>Restaurante &amp; Café', '<cac:PartyLegalEntity><cbc:RegistrationName>Otra empresa')],
    ['missing supplier DV', (s: string) => s.replaceAll(' schemeID="1"', '')],
    ['invalid payment form', (s: string) => s.replace('<cac:PaymentMeans><cbc:ID>1', '<cac:PaymentMeans><cbc:ID>3')],
    ['nonzero prepaid', (s: string) => s.replace('0.00</cbc:PrepaidAmount>', '1.00</cbc:PrepaidAmount>')],
    ['unsupported item standard', (s: string) => s.replaceAll('schemeID="999"', 'schemeID="001"')],
    ['unsupported quantity unit', (s: string) => s.replaceAll('unitCode="EA"', 'unitCode="KGM"')],
    ['fractional quantity', (s: string) => s.replace('>2.000000</cbc:InvoicedQuantity>', '>2.500000</cbc:InvoicedQuantity>')],
    ['incorrect document tax amount', (s: string) => s.replace('16.00</cbc:TaxAmount>', '17.00</cbc:TaxAmount>')],
    ['fake namespace', (s: string) => s.replaceAll('CommonBasicComponents-2', 'Fake-2')],
  ])('rejects %s rather than inventing fiscal values', (_name, mutate) => {
    expect(() => parseAcceptedInvoiceXml(mutate(xml()))).toThrow('source_unsupported');
  });
});

// Facturas nuevas: el descuento del cliente va DENTRO de cada línea
// (cac:InvoiceLine/cac:AllowanceCharge, ver discountedLines.ts). La nota se
// reconstruye con las líneas NETAS: lo máximo a acreditar por línea es lo
// que se cobró por ella. Las facturas viejas (sin descuento en las líneas)
// se leen como siempre — el bloque de arriba sigue pasando sin cambios.
describe('accepted invoice with the customer discount inside its lines', () => {
  const items = [
    { nameSnapshot: 'Plato & bebida', qty: 2, priceCentsSnapshot: 10_800, cancelledAt: null, taxKind: null, taxPct: null },
    { nameSnapshot: 'Postre', qty: 1, priceCentsSnapshot: 5_400, cancelledAt: null, taxKind: null, taxPct: null },
  ];
  // Subtotal 27.000 centavos, 20 % de descuento = 5.400.
  const sale = saleLines(items, { kind: 'inc', pct: 8 }, 5_400);
  const discountedXml = () => buildDianInvoiceXml({ ...originalInvoiceInput, lines: sale.lines }).xml;

  it('reads net lines, keeps the discount per line and matches the accepted totals', () => {
    const source = parseAcceptedInvoiceXml(discountedXml());
    expect(source.lines.map((l) => [l.lineTotalCents, l.taxCents, l.allowanceCents])).toEqual(
      sale.lines.map((l) => [l.lineTotalCents, l.taxCents, l.allowanceCents]),
    );
    expect(source.lines.reduce((s, l) => s + l.grossCents, 0)).toBe(27_000 - 5_400);
    expect(source.totals.payableCents).toBe(21_600);
    expect(source.totals.taxIncCents).toBe(sale.embedded.taxCents);
  });

  it('a total credit note credits what was charged, not the list price', () => {
    const source = parseAcceptedInvoiceXml(discountedXml());
    const proposal = buildProposal(remainingLines(source.lines, []), {
      originalInvoiceId: 'i', sourceVersion: 'v', mode: 'total', reasonCode: '2', reasonText: 'Anulación',
    });
    expect(proposal.totalCents).toBe(21_600);
    expect(proposal.taxCents).toBe(sale.embedded.taxCents);
    const note = buildDianCreditNoteXml({
      ...originalInvoiceInput, invoiceNumber: 'NC1', lines: proposal.lines,
      reference: { invoiceNumber: source.invoiceNumber, cufe: source.cufe, issueDate: source.issueDate },
      discrepancyCode: '2',
    });
    // La nota no lleva descuentos: acredita importes netos.
    expect(note.xml).not.toContain('AllowanceCharge>');
    expect(note.totals.payableCents).toBe(21_600);
  });

  it.each([
    ['a charge instead of a discount', (s: string) => s.replace('<cbc:ChargeIndicator>false', '<cbc:ChargeIndicator>true')],
    ['a coded line discount', (s: string) => s.replace('<cbc:AllowanceChargeReason>', '<cbc:AllowanceChargeReasonCode>00</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>')],
    ['a base that is not the line before the discount', (s: string) => s.replace(/(<cbc:BaseAmount currencyID="COP">)(\d+)\./, (_m, a: string, b: string) => `${a}${Number(b) + 1}.`)],
    ['a percentage that does not match the amounts', (s: string) => s.replace('<cbc:MultiplierFactorNumeric>20.00', '<cbc:MultiplierFactorNumeric>35.00')],
    ['two discounts on one line', (s: string) => s.replace(/(<cac:AllowanceCharge>.*?<\/cac:AllowanceCharge>)/, '$1$1')],
    ['a document-level discount', (s: string) => s.replace('<cac:LegalMonetaryTotal>', '<cac:AllowanceCharge><cbc:ID>1</cbc:ID></cac:AllowanceCharge><cac:LegalMonetaryTotal>')],
    ['a discount hidden inside the price', (s: string) => s.replace('</cac:Price>', '<cac:AllowanceCharge/></cac:Price>')],
  ])('rejects %s rather than inventing fiscal values', (_name, mutate) => {
    const original = discountedXml();
    expect(mutate(original)).not.toBe(original);
    expect(() => parseAcceptedInvoiceXml(mutate(original))).toThrow('source_unsupported');
  });
});
