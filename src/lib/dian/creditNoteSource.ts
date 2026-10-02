/**
 * Fiscal source for a credit note: ONLY the stored, accepted Invoice XML.
 * This reader supports MESAPAY's COP / EA / IVA+INC profile. Other UBL
 * profiles fail explicitly, so allowances, tips, retentions or extra taxes
 * can never disappear while a credit note is reconstructed.
 * Acceptance and the XML's ownership/signature are verified by the caller.
 */
import { DOMParser, type Element } from '@xmldom/xmldom';
import { computeDianTotals, type DianLine, type DianParty, type DianTotals } from './ubl';

export type CreditNoteSource = {
  currency: 'COP';
  invoiceNumber: string;
  cufe: string;
  issueDate: string;
  issueTime: string;
  environment: '1' | '2';
  supplier: DianParty;
  customer: DianParty;
  lines: (DianLine & { lineId: string; grossCents: number })[];
  totals: DianTotals;
  paymentMeansCode: string;
  paymentMeansId: '1' | '2';
  paymentDueDate?: string;
};
export class CreditNoteSourceError extends Error {
  readonly code = 'source_unsupported';
  constructor() { super('source_unsupported'); }
}
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const INVOICE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new CreditNoteSourceError();
}
function elements(parent: Element, ns: string, name: string): Element[] {
  return Array.from(parent.childNodes).filter((node): node is Element =>
    node.nodeType === 1 && (node as Element).namespaceURI === ns && node.localName === name);
}
function one(parent: Element, ns: string, name: string): Element {
  const nodes = elements(parent, ns, name);
  requireValue(nodes.length === 1);
  return nodes[0];
}
function optional(parent: Element, ns: string, name: string): Element | undefined {
  const nodes = elements(parent, ns, name);
  requireValue(nodes.length <= 1);
  return nodes[0];
}
function text(node: Element): string {
  requireValue(!Array.from(node.childNodes).some((n) => n.nodeType === 1));
  const value = node.textContent?.trim();
  requireValue(value);
  return value;
}
function basic(parent: Element, name: string): string { return text(one(parent, CBC, name)); }
function optionalBasic(parent: Element, name: string): string | undefined {
  const node = optional(parent, CBC, name);
  return node ? text(node) : undefined;
}
function amount(node: Element): number {
  requireValue(node.getAttribute('currencyID') === 'COP');
  const value = text(node);
  requireValue(/^\d+(?:\.\d{1,2})?$/.test(value));
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  requireValue(cents <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(cents);
}
function money(parent: Element, name: string): number { return amount(one(parent, CBC, name)); }
function safeSum(values: number[]): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), BigInt(0));
  requireValue(total <= BigInt(Number.MAX_SAFE_INTEGER));
  return Number(total);
}
function date(value: string): string {
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(value));
  const parsed = new Date(value + 'T00:00:00Z');
  requireValue(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value);
  return value;
}
function party(root: Element, kind: 'Supplier' | 'Customer'): DianParty {
  const account = one(root, CAC, `Accounting${kind}Party`);
  const personType = basic(account, 'AdditionalAccountID');
  requireValue(personType === '1' || personType === '2');
  const p = one(account, CAC, 'Party');
  const fiscal = one(p, CAC, 'PartyTaxScheme');
  const company = one(fiscal, CBC, 'CompanyID');
  const idSchemeName = company.getAttribute('schemeName');
  requireValue(['13', '22', '31', '41'].includes(idSchemeName ?? ''));
  const companyId = text(company);
  const dv = company.getAttribute('schemeID');
  if (idSchemeName === '31') requireValue(dv && /^\d$/.test(dv));
  const tax = basic(one(fiscal, CAC, 'TaxScheme'), 'ID');
  requireValue(tax === '01' || tax === 'ZZ');
  const result: DianParty = {
    name: basic(fiscal, 'RegistrationName'), companyId,
    idSchemeName: idSchemeName as DianParty['idSchemeName'],
    personType, taxLevelCode: basic(fiscal, 'TaxLevelCode'),
    taxRegimeCode: tax === '01' ? '48' : '49',
    ...(idSchemeName === '31' ? { dv } : {}),
  };
  const legal = one(p, CAC, 'PartyLegalEntity');
  requireValue(basic(legal, 'CompanyID') === companyId);
  requireValue(basic(legal, 'RegistrationName') === result.name);
  const location = optional(p, CAC, 'PhysicalLocation');
  if (location) {
    const a = one(location, CAC, 'Address');
    requireValue(basic(one(a, CAC, 'Country'), 'IdentificationCode') === 'CO');
    result.address = {
      cityCode: basic(a, 'ID'), cityName: basic(a, 'CityName'),
      deptCode: basic(a, 'CountrySubentityCode'), deptName: basic(a, 'CountrySubentity'),
      line: basic(one(a, CAC, 'AddressLine'), 'Line'),
      ...(optionalBasic(a, 'PostalZone') ? { postalZone: basic(a, 'PostalZone') } : {}),
    };
  }
  if (kind === 'Supplier') requireValue(result.address && idSchemeName === '31');
  const contact = optional(p, CAC, 'Contact');
  if (contact) {
    const email = optionalBasic(contact, 'ElectronicMail');
    const phone = optionalBasic(contact, 'Telephone');
    if (email) result.email = email;
    if (phone) result.phone = phone;
  }
  return result;
}
type ParsedTax = { scheme: '01' | '04'; pct: string; base: number; tax: number };
function taxSubtotals(total: Element, checkRate = false): ParsedTax[] {
  const subs = elements(total, CAC, 'TaxSubtotal');
  requireValue(subs.length > 0);
  const parsed: ParsedTax[] = subs.map((sub): ParsedTax => {
    const category = one(sub, CAC, 'TaxCategory');
    const scheme = basic(one(category, CAC, 'TaxScheme'), 'ID');
    requireValue(scheme === '01' || scheme === '04');
    const rawPct = basic(category, 'Percent');
    requireValue(/^\d{1,2}(?:\.\d{1,2})?$/.test(rawPct));
    const pct = Number(rawPct).toFixed(2);
    const base = money(sub, 'TaxableAmount');
    const tax = money(sub, 'TaxAmount');
    requireValue(tax > 0 && base > 0);
    // The accepted source can carry cent rounding, but not a different base/rate.
    const pct100 = BigInt(Math.round(Number(pct) * 100));
    const expected = (BigInt(base) * pct100 + BigInt(5000)) / BigInt(10000);
    if (checkRate) requireValue(BigInt(tax) - expected >= -BigInt(2) && BigInt(tax) - expected <= BigInt(2));
    return { scheme, pct, base, tax };
  });
  requireValue(money(total, 'TaxAmount') === safeSum(parsed.map((s) => s.tax)));
  return parsed;
}
function readLine(node: Element): CreditNoteSource['lines'][number] {
  const qty = one(node, CBC, 'InvoicedQuantity');
  requireValue(qty.getAttribute('unitCode') === 'EA');
  const rawQty = text(qty);
  requireValue(/^\d+(?:\.0{1,6})?$/.test(rawQty));
  const quantity = Number(rawQty);
  requireValue(Number.isSafeInteger(quantity) && quantity > 0);
  const lineTotalCents = money(node, 'LineExtensionAmount');
  requireValue(lineTotalCents > 0);
  const price = one(node, CAC, 'Price');
  const unitPriceCents = money(price, 'PriceAmount');
  const baseQty = one(price, CBC, 'BaseQuantity');
  requireValue(baseQty.getAttribute('unitCode') === 'EA' && Number(text(baseQty)) === 1);
  // MESAPAY rounds unit prices separately. Keep original line base as authoritative.
  requireValue(Math.abs(unitPriceCents * quantity - lineTotalCents) <= quantity);
  const totals = elements(node, CAC, 'TaxTotal');
  requireValue(totals.length <= 1);
  const taxes = totals.flatMap((total) => taxSubtotals(total, true));
  requireValue(taxes.length <= 1);
  const tax = taxes[0];
  if (tax) requireValue(tax.base === lineTotalCents);
  const item = one(node, CAC, 'Item');
  const itemId = one(one(item, CAC, 'StandardItemIdentification'), CBC, 'ID');
  requireValue(itemId.getAttribute('schemeID') === '999');
  return {
    lineId: basic(node, 'ID'), description: basic(item, 'Description'), quantity,
    unitPriceCents, lineTotalCents, taxCents: tax?.tax ?? 0,
    taxPct: tax?.pct ?? '0.00', taxSchemeId: tax?.scheme ?? '04', itemCode: text(itemId),
    grossCents: safeSum([lineTotalCents, tax?.tax ?? 0]),
  };
}

export function parseAcceptedInvoiceXml(xml: string): CreditNoteSource {
  try {
    requireValue(xml.length > 0 && xml.length <= 5_000_000);
    requireValue(!/<!DOCTYPE|<!ENTITY/i.test(xml));
    const document = new DOMParser({ onError: () => { throw new CreditNoteSourceError(); } })
      .parseFromString(xml, 'application/xml');
    const root = document.documentElement;
    requireValue(root?.localName === 'Invoice' && root.namespaceURI === INVOICE);
    requireValue(basic(root, 'DocumentCurrencyCode') === 'COP');
    requireValue(basic(root, 'InvoiceTypeCode') === '01');
    requireValue(basic(root, 'CustomizationID') === '10');
    for (const unsupported of ['AllowanceCharge', 'WithholdingTaxTotal', 'PrepaidPayment', 'PaymentExchangeRate', 'TaxExchangeRate', 'PricingExchangeRate']) {
      requireValue(root.getElementsByTagNameNS(CAC, unsupported).length === 0);
    }
    const environment = basic(root, 'ProfileExecutionID');
    requireValue(environment === '1' || environment === '2');
    const uuid = one(root, CBC, 'UUID');
    const cufe = text(uuid);
    requireValue(/^[a-fA-F0-9]{96}$/.test(cufe));
    requireValue(uuid.getAttribute('schemeName') === 'CUFE-SHA384');
    requireValue(uuid.getAttribute('schemeID') === environment);
    const issueTime = basic(root, 'IssueTime');
    requireValue(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d-05:00$/.test(issueTime));
    const lineNodes = elements(root, CAC, 'InvoiceLine');
    requireValue(lineNodes.length > 0 && lineNodes.length <= 1000);
    const lines = lineNodes.map(readLine);
    requireValue(new Set(lines.map((line) => line.lineId)).size === lines.length);
    requireValue(Number(basic(root, 'LineCountNumeric')) === lines.length);
    safeSum(lines.map((line) => line.grossCents));
    const totals = computeDianTotals(lines);
    const legal = one(root, CAC, 'LegalMonetaryTotal');
    requireValue(money(legal, 'LineExtensionAmount') === totals.lineExtensionCents);
    requireValue(money(legal, 'TaxExclusiveAmount') === totals.taxableBaseCents);
    requireValue(money(legal, 'TaxInclusiveAmount') === totals.payableCents);
    requireValue(money(legal, 'PayableAmount') === totals.payableCents);
    for (const name of ['AllowanceTotalAmount', 'ChargeTotalAmount', 'PrepaidAmount', 'PayableRoundingAmount']) {
      const node = optional(legal, CBC, name);
      if (node) requireValue(amount(node) === 0);
    }
    const expected = new Map<string, { base: number; tax: number }>();
    for (const line of lines.filter((line) => line.taxCents > 0)) {
      const key = `${line.taxSchemeId}:${line.taxPct}`;
      const before = expected.get(key) ?? { base: 0, tax: 0 };
      expected.set(key, { base: safeSum([before.base, line.lineTotalCents]), tax: safeSum([before.tax, line.taxCents]) });
    }
    const documentTaxes = elements(root, CAC, 'TaxTotal').flatMap((total) => taxSubtotals(total));
    requireValue(documentTaxes.length === expected.size);
    const seen = new Set<string>();
    for (const tax of documentTaxes) {
      const key = `${tax.scheme}:${tax.pct}`;
      requireValue(!seen.has(key));
      seen.add(key);
      requireValue(expected.get(key)?.base === tax.base && expected.get(key)?.tax === tax.tax);
    }
    const payment = one(root, CAC, 'PaymentMeans');
    const paymentMeansId = basic(payment, 'ID');
    requireValue(paymentMeansId === '1' || paymentMeansId === '2');
    const paymentDueDate = optionalBasic(payment, 'PaymentDueDate');
    return {
      currency: 'COP', invoiceNumber: basic(root, 'ID'), cufe, environment,
      issueDate: date(basic(root, 'IssueDate')), issueTime,
      supplier: party(root, 'Supplier'), customer: party(root, 'Customer'), lines, totals,
      paymentMeansCode: basic(payment, 'PaymentMeansCode'), paymentMeansId,
      ...(paymentDueDate ? { paymentDueDate: date(paymentDueDate) } : {}),
    };
  } catch {
    throw new CreditNoteSourceError();
  }
}
