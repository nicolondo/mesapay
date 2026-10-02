// DIAN Anexo Técnico 1.9 §6.2 and §§11.4.3–11.4.4 (CreditNote/CUDE).
// https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Factura-Electronica-de-Venta-vr-1-9.pdf
// Numbering is internal; credit notes never consume an invoice resolution.
import { computeCufe, dianQrUrl, centsToDianAmount, type CufeInputs } from "./crypto";
import {
  computeDianTotals, softwareSecurityCode, partyXml, taxTotalXml,
  type TaxSubtotal, type DianLine, type DianInvoiceInput, type BuiltDianInvoice,
} from "./ubl";

// Official 2026 toolbox, table 13.2.4. These are fiscal XML literals, not UI copy.
export const CREDIT_NOTE_REASONS = {
  "1": "Devolución parcial de los bienes y/o no aceptación parcial del servicio",
  "2": "Anulación de factura electrónica",
  "3": "Rebaja  o descuento parcial o total",
  "4": "Ajuste de precio",
  "5": "Descuento comercial por pronto pago",
  "6": "Descuento comercial por volumen de ventas",
} as const;
export type CreditNoteReasonCode = keyof typeof CREDIT_NOTE_REASONS;
export type DianCreditNoteInput = Omit<DianInvoiceInput, "technicalKey" | "resolution" | "lines"> & {
  prefix?: string;
  lines: (DianLine & { originalLineId?: string })[];
  reference: { invoiceNumber: string; cufe: string; issueDate: string };
  discrepancyCode: CreditNoteReasonCode;
  /** Optional explanation belongs in cbc:Note; Description is the official reason literal. */
  discrepancyDescription?: string;
};
const A = centsToDianAmount;
function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildDianCreditNoteXml(i: DianCreditNoteInput): BuiltDianInvoice {
  // A partial adjustment can round tax to zero while remaining taxable.
  const declaresTax = (line: DianLine) => line.taxCents > 0 || Number(line.taxPct) > 0;
  const totals = {
    ...computeDianTotals(i.lines),
    taxableBaseCents: i.lines.filter(declaresTax).reduce((sum, line) => sum + line.lineTotalCents, 0),
  };
  const cufeInputs: CufeInputs = {
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
    key: i.softwarePin,
    environment: i.environment,
  };
  const cufe = computeCufe(cufeInputs, "cude");
  const qrUrl = dianQrUrl(cufe, i.environment);
  const securityCode = softwareSecurityCode(
    i.softwareId,
    i.softwarePin,
    i.invoiceNumber,
  );

  // Agrupación de impuestos a nivel documento: un TaxTotal por scheme y
  // dentro, un TaxSubtotal por tarifa. Sólo entran las líneas que
  // declaran impuesto — el mismo criterio que usa el detalle, para que
  // base del documento y suma de bases de línea sean idénticas (FAU04).
  const taxGroups: string[] = [];
  for (const schemeId of ["01", "04"] as const) {
    const group = i.lines.filter(
      (l) => l.taxSchemeId === schemeId && declaresTax(l),
    );
    if (group.length === 0) continue;
    const byPct = new Map<string, TaxSubtotal>();
    for (const l of group) {
      const acc = byPct.get(l.taxPct) ?? {
        taxCents: 0,
        taxableCents: 0,
        pct: l.taxPct,
      };
      acc.taxCents += l.taxCents;
      acc.taxableCents += l.lineTotalCents;
      byPct.set(l.taxPct, acc);
    }
    taxGroups.push(taxTotalXml(schemeId, [...byPct.values()]));
  }

  const linesXml = i.lines
    .map((l, idx) => {
      // FAZ09: el grupo de identificación del bien o servicio es
      // obligatorio. schemeID 999 = estándar de adopción del
      // contribuyente (no usamos UNSPSC ni GTIN en la carta).
      const itemId = esc(String(l.itemCode ?? idx + 1));
      return (
        `<cac:CreditNoteLine>` +
        `<cbc:ID>${idx + 1}</cbc:ID>` +
        (l.originalLineId ? `<cbc:Note>Referencia a la línea original: ${esc(l.originalLineId)}</cbc:Note>` : "") +
        `<cbc:CreditedQuantity unitCode="EA">${l.quantity}.000000</cbc:CreditedQuantity>` +
        `<cbc:LineExtensionAmount currencyID="COP">${A(l.lineTotalCents)}</cbc:LineExtensionAmount>` +
        (declaresTax(l)
          ? taxTotalXml(l.taxSchemeId, [
              { taxCents: l.taxCents, taxableCents: l.lineTotalCents, pct: l.taxPct },
            ])
          : "") +
        `<cac:Item><cbc:Description>${esc(l.description)}</cbc:Description>` +
        `<cac:StandardItemIdentification>` +
        `<cbc:ID schemeID="999" schemeName="Estándar de adopción del contribuyente">${itemId}</cbc:ID>` +
        `</cac:StandardItemIdentification>` +
        `</cac:Item>` +
        `<cac:Price>` +
        `<cbc:PriceAmount currencyID="COP">${A(l.unitPriceCents)}</cbc:PriceAmount>` +
        `<cbc:BaseQuantity unitCode="EA">1.000000</cbc:BaseQuantity>` +
        `</cac:Price>` +
        `</cac:CreditNoteLine>`
      );
    })
    .join("");

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" ` +
    `xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ` +
    `xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" ` +
    `xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ` +
    `xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" ` +
    `xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1" ` +
    `xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" ` +
    `xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<ext:UBLExtensions>` +
    `<ext:UBLExtension><ext:ExtensionContent>` +
    `<sts:DianExtensions>` +
    `<sts:InvoiceSource><cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode></sts:InvoiceSource>` +
    // MESAPAY es SOFTWARE PROPIO: el comercio registra su propio software
    // en el portal DIAN, así que el "Prestador de Servicios" (ProviderID)
    // es su MISMO NIT — no el de un proveedor tecnológico externo. Lo que
    // faltaba era el DV en @schemeID: sin él la DIAN no encuentra el NIT
    // (FAB19a) y rechaza por DV no informado / mal calculado (FAB22a/b).
    `<sts:SoftwareProvider>` +
    `<sts:ProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"${i.supplier.dv != null ? ` schemeID="${esc(i.supplier.dv)}"` : ""} schemeName="31">${esc(i.supplier.companyId)}</sts:ProviderID>` +
    `<sts:SoftwareID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${esc(i.softwareId)}</sts:SoftwareID>` +
    `</sts:SoftwareProvider>` +
    `<sts:SoftwareSecurityCode schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${securityCode}</sts:SoftwareSecurityCode>` +
    `<sts:AuthorizationProvider><sts:AuthorizationProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="4" schemeName="31">800197268</sts:AuthorizationProviderID></sts:AuthorizationProvider>` +
    `<sts:QRCode>${esc(qrUrl)}</sts:QRCode>` +
    `</sts:DianExtensions>` +
    `</ext:ExtensionContent></ext:UBLExtension>` +
    `<ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension>` +
    `</ext:UBLExtensions>` +
    `<cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>` +
    `<cbc:CustomizationID>20</cbc:CustomizationID>` +
    // FAD03: la DIAN compara el literal EXACTO, con mayúsculas incluidas.
    `<cbc:ProfileID>DIAN 2.1: Nota Crédito de Factura Electrónica de Venta</cbc:ProfileID>` +
    `<cbc:ProfileExecutionID>${i.environment}</cbc:ProfileExecutionID>` +
    `<cbc:ID>${esc(i.invoiceNumber)}</cbc:ID>` +
    `<cbc:UUID schemeID="${i.environment}" schemeName="CUDE-SHA384">${cufe}</cbc:UUID>` +
    `<cbc:IssueDate>${i.issueDate}</cbc:IssueDate>` +
    `<cbc:IssueTime>${i.issueTime}</cbc:IssueTime>` +
    `<cbc:CreditNoteTypeCode>91</cbc:CreditNoteTypeCode>` +
    ((i.note || i.discrepancyDescription) ? `<cbc:Note>${esc(i.note || i.discrepancyDescription || "")}</cbc:Note>` : "") +
    `<cbc:DocumentCurrencyCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listID="ISO 4217 Alpha">COP</cbc:DocumentCurrencyCode>` +
    `<cbc:LineCountNumeric>${i.lines.length}</cbc:LineCountNumeric>` +
    `<cac:DiscrepancyResponse>` +
    `<cbc:ResponseCode>${i.discrepancyCode}</cbc:ResponseCode>` +
    `<cbc:Description>${esc(CREDIT_NOTE_REASONS[i.discrepancyCode])}</cbc:Description>` +
    `</cac:DiscrepancyResponse>` +
    `<cac:BillingReference><cac:InvoiceDocumentReference>` +
    `<cbc:ID>${esc(i.reference.invoiceNumber)}</cbc:ID>` +
    `<cbc:UUID schemeName="CUFE-SHA384">${esc(i.reference.cufe)}</cbc:UUID>` +
    `<cbc:IssueDate>${i.reference.issueDate}</cbc:IssueDate>` +
    `</cac:InvoiceDocumentReference></cac:BillingReference>` +
    partyXml("supplier", i.supplier, i.prefix) +
    partyXml("customer", i.customer) +
    `<cac:PaymentMeans><cbc:ID>${i.paymentMeansId ?? "1"}</cbc:ID><cbc:PaymentMeansCode>${esc(i.paymentMeansCode)}</cbc:PaymentMeansCode><cbc:PaymentDueDate>${i.paymentDueDate ?? i.issueDate}</cbc:PaymentDueDate><cbc:PaymentID>1</cbc:PaymentID></cac:PaymentMeans>` +
    taxGroups.join("") +
    `<cac:LegalMonetaryTotal>` +
    `<cbc:LineExtensionAmount currencyID="COP">${A(totals.lineExtensionCents)}</cbc:LineExtensionAmount>` +
    // TaxExclusiveAmount es la BASE IMPONIBLE, no el bruto: la DIAN la
    // compara contra la suma de las bases de las líneas (FAU04). Antes
    // mandábamos el bruto y con líneas sin impuesto no cuadraba nunca.
    `<cbc:TaxExclusiveAmount currencyID="COP">${A(totals.taxableBaseCents)}</cbc:TaxExclusiveAmount>` +
    `<cbc:TaxInclusiveAmount currencyID="COP">${A(totals.payableCents)}</cbc:TaxInclusiveAmount>` +
    `<cbc:AllowanceTotalAmount currencyID="COP">0.00</cbc:AllowanceTotalAmount>` +
    `<cbc:PrepaidAmount currencyID="COP">0.00</cbc:PrepaidAmount>` +
    `<cbc:PayableAmount currencyID="COP">${A(totals.payableCents)}</cbc:PayableAmount>` +
    `</cac:LegalMonetaryTotal>` +
    linesXml +
    `</CreditNote>`;

  return { xml, cufe, qrUrl, securityCode, totals };
}
