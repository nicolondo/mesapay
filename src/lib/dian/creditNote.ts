// Builder UBL 2.1 de nota crédito DIAN (ERP B1.6) — acredita una factura
// aceptada. CUDE (no CUFE): usa el Software PIN en vez de la clave
// técnica y omite los bloques de impuestos por código en la
// concatenación (misma regla que crypto.ts). Estructura CreditNote-2
// con BillingReference a la factura original. Función pura, desde el
// Anexo Técnico 1.9.
import { computeCufe, dianQrUrl, centsToDianAmount, type CufeInputs } from "@/lib/dian/crypto";
import {
  computeDianTotals,
  softwareSecurityCode,
  type DianInvoiceInput,
  type BuiltDianInvoice,
} from "@/lib/dian/ubl";

const A = centsToDianAmount;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type DianCreditNoteInput = DianInvoiceInput & {
  /** Factura que se acredita. */
  reference: {
    invoiceNumber: string;
    cufe: string;
    issueDate: string;
  };
  /** Concepto (anexo 6.1.2): "1" devolución, "2" anulación, "3" rebaja, "4" ajuste. */
  discrepancyCode: "1" | "2" | "3" | "4";
  discrepancyDescription: string;
};

/**
 * Construye la nota crédito firmable (slot de firma vacío para B1.2).
 * El CUDE se calcula con el PIN del software (softwarePin) en el campo
 * `key` y sin bloques de impuestos.
 */
export function buildDianCreditNoteXml(i: DianCreditNoteInput): BuiltDianInvoice {
  const totals = computeDianTotals(i.lines);
  const cudeInputs: CufeInputs = {
    invoiceNumber: i.invoiceNumber,
    issueDate: i.issueDate,
    issueTime: i.issueTime,
    lineExtensionAmount: A(totals.lineExtensionCents),
    taxIva: A(totals.taxIvaCents),
    taxInc: A(totals.taxIncCents),
    taxIca: A(totals.taxIcaCents),
    payableAmount: A(totals.payableCents),
    supplierNit: i.supplier.companyId,
    customerId: i.customer.companyId,
    key: i.softwarePin, // CUDE usa el PIN
    environment: i.environment,
  };
  const cude = computeCufe(cudeInputs, "cude");
  const qrUrl = dianQrUrl(cude, i.environment);
  const securityCode = softwareSecurityCode(i.softwareId, i.softwarePin, i.invoiceNumber);

  const linesXml = i.lines
    .map((l, idx) => {
      return (
        `<cac:CreditNoteLine>` +
        `<cbc:ID>${idx + 1}</cbc:ID>` +
        `<cbc:CreditedQuantity unitCode="EA">${l.quantity}.000000</cbc:CreditedQuantity>` +
        `<cbc:LineExtensionAmount currencyID="COP">${A(l.lineTotalCents)}</cbc:LineExtensionAmount>` +
        `<cac:Item><cbc:Description>${esc(l.description)}</cbc:Description></cac:Item>` +
        `<cac:Price><cbc:PriceAmount currencyID="COP">${A(l.unitPriceCents)}</cbc:PriceAmount>` +
        `<cbc:BaseQuantity unitCode="EA">1.000000</cbc:BaseQuantity></cac:Price>` +
        `</cac:CreditNoteLine>`
      );
    })
    .join("");

  const party = (kind: "supplier" | "customer") => {
    const p = kind === "supplier" ? i.supplier : i.customer;
    const tag =
      kind === "supplier" ? "AccountingSupplierParty" : "AccountingCustomerParty";
    return (
      `<cac:${tag}><cbc:AdditionalAccountID>${p.personType}</cbc:AdditionalAccountID>` +
      `<cac:Party><cac:PartyName><cbc:Name>${esc(p.name)}</cbc:Name></cac:PartyName>` +
      `<cac:PartyLegalEntity><cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>` +
      `<cbc:CompanyID schemeName="${p.idSchemeName}" schemeAgencyID="195">${esc(p.companyId)}</cbc:CompanyID>` +
      `</cac:PartyLegalEntity></cac:Party></cac:${tag}>`
    );
  };

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" ` +
    `xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ` +
    `xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" ` +
    `xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ` +
    `xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" ` +
    `xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1" ` +
    `xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">` +
    `<ext:UBLExtensions>` +
    `<ext:UBLExtension><ext:ExtensionContent>` +
    `<sts:DianExtensions>` +
    `<sts:SoftwareProvider>` +
    `<sts:ProviderID schemeAgencyID="195" schemeName="31">${esc(i.supplier.companyId)}</sts:ProviderID>` +
    `<sts:SoftwareID schemeAgencyID="195">${esc(i.softwareId)}</sts:SoftwareID>` +
    `</sts:SoftwareProvider>` +
    `<sts:SoftwareSecurityCode schemeAgencyID="195">${securityCode}</sts:SoftwareSecurityCode>` +
    `<sts:QRCode>${esc(qrUrl)}</sts:QRCode>` +
    `</sts:DianExtensions>` +
    `</ext:ExtensionContent></ext:UBLExtension>` +
    `<ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension>` +
    `</ext:UBLExtensions>` +
    `<cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>` +
    `<cbc:CustomizationID>20</cbc:CustomizationID>` +
    `<cbc:ProfileID>DIAN 2.1: Nota Crédito de Factura Electrónica de Venta</cbc:ProfileID>` +
    `<cbc:ProfileExecutionID>${i.environment}</cbc:ProfileExecutionID>` +
    `<cbc:ID>${esc(i.invoiceNumber)}</cbc:ID>` +
    `<cbc:UUID schemeID="${i.environment}" schemeName="CUDE-SHA384">${cude}</cbc:UUID>` +
    `<cbc:IssueDate>${i.issueDate}</cbc:IssueDate>` +
    `<cbc:IssueTime>${i.issueTime}</cbc:IssueTime>` +
    `<cbc:CreditNoteTypeCode>91</cbc:CreditNoteTypeCode>` +
    `<cbc:DocumentCurrencyCode>COP</cbc:DocumentCurrencyCode>` +
    `<cbc:LineCountNumeric>${i.lines.length}</cbc:LineCountNumeric>` +
    `<cac:DiscrepancyResponse>` +
    `<cbc:ReferenceID>${esc(i.reference.invoiceNumber)}</cbc:ReferenceID>` +
    `<cbc:ResponseCode>${i.discrepancyCode}</cbc:ResponseCode>` +
    `<cbc:Description>${esc(i.discrepancyDescription)}</cbc:Description>` +
    `</cac:DiscrepancyResponse>` +
    `<cac:BillingReference><cac:InvoiceDocumentReference>` +
    `<cbc:ID>${esc(i.reference.invoiceNumber)}</cbc:ID>` +
    `<cbc:UUID schemeName="CUFE-SHA384">${esc(i.reference.cufe)}</cbc:UUID>` +
    `<cbc:IssueDate>${i.reference.issueDate}</cbc:IssueDate>` +
    `</cac:InvoiceDocumentReference></cac:BillingReference>` +
    party("supplier") +
    party("customer") +
    `<cac:LegalMonetaryTotal>` +
    `<cbc:LineExtensionAmount currencyID="COP">${A(totals.lineExtensionCents)}</cbc:LineExtensionAmount>` +
    `<cbc:TaxExclusiveAmount currencyID="COP">${A(totals.lineExtensionCents)}</cbc:TaxExclusiveAmount>` +
    `<cbc:TaxInclusiveAmount currencyID="COP">${A(totals.payableCents)}</cbc:TaxInclusiveAmount>` +
    `<cbc:PayableAmount currencyID="COP">${A(totals.payableCents)}</cbc:PayableAmount>` +
    `</cac:LegalMonetaryTotal>` +
    linesXml +
    `</CreditNote>`;

  return { xml, cufe: cude, qrUrl, securityCode, totals };
}
