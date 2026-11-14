// Builder UBL 2.1 del documento soporte (Invoice tipo 05) y de su nota de
// ajuste (CreditNote tipo 95) — Anexo Técnico DS v1.1 (Res. DIAN 000167 de
// 2021). Función pura: recibe todo resuelto y devuelve el XML SIN firmar
// (deja el segundo ExtensionContent vacío para `signXmlDian`, igual que la
// factura) junto con el CUDS, el código de seguridad y los totales.
//
// Diferencias con la factura que este builder respeta:
//   · Los roles se invierten: AccountingSupplierParty es el VENDEDOR no
//     obligado y AccountingCustomerParty es el comercio (pág. 34 y 39).
//   · El vendedor lleva PhysicalLocation + PartyTaxScheme, SIN
//     PartyLegalEntity ni Contact; el adquiriente sólo PartyTaxScheme (la
//     v1.1 eliminó esos grupos, control de versiones pág. 12).
//   · Cada línea lleva cac:InvoicePeriod con la fecha de compra y la forma
//     de generación (DSFC01–DSFC04).
//   · Sólo hay IVA; las retenciones (ReteIVA 05, ReteRenta 06) van en
//     cac:WithholdingTaxTotal de la línea y del documento y NO afectan el
//     LegalMonetaryTotal (§14.3.1, pág. 217).
//   · La nota de ajuste no lleva InvoiceControl (la tabla salta de NSAB03 a
//     NSAB13) y su numeración es interna (art. 5 num. 2 Res. 000167).
import { centsToDianAmount } from "@/lib/dian/crypto";
import { softwareSecurityCode, type DianResolution } from "@/lib/dian/ubl";
import { computeCuds } from "./cuds";
import {
  ADJUSTMENT_REASONS,
  CUDS_SCHEME_NAME,
  DS_INVOICE_TYPE_CODE,
  DS_PROFILE_ID,
  GENERATION_FORMS,
  NAS_CREDIT_NOTE_TYPE_CODE,
  NAS_PROFILE_ID,
  TAX_SCHEMES,
  supportDocQrUrl,
  type AdjustmentReasonCode,
  type WithholdingSchemeId,
} from "./constants";
import type {
  SupportDocBuyer,
  SupportDocLine,
  SupportDocPaymentMeans,
  SupportDocReference,
  SupportDocSeller,
  SupportDocTotals,
} from "./types";

const A = centsToDianAmount;
const AGENCY = `schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"`;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type CommonInput = {
  environment: "1" | "2";
  softwareId: string;
  softwarePin: string;
  /** Prefijo + número (sin espacios ni guiones, DSAD05a). */
  documentNumber: string;
  issueDate: string;
  issueTime: string;
  customizationId: "10" | "11";
  seller: SupportDocSeller;
  buyer: SupportDocBuyer;
  lines: SupportDocLine[];
  paymentMeans: SupportDocPaymentMeans;
  note?: string | null;
};

export type SupportDocXmlInput = CommonInput & { resolution: DianResolution };

export type AdjustmentNoteXmlInput = CommonInput & {
  reference: SupportDocReference;
  reasonCode: AdjustmentReasonCode;
  /** Descripción de la corrección (NSBF04, 20 a 5000 caracteres). */
  reasonText: string;
};

export type BuiltSupportDoc = {
  xml: string;
  cuds: string;
  qrUrl: string;
  securityCode: string;
  totals: SupportDocTotals;
};

/** ¿La línea declara IVA? Mismo criterio para el detalle y el total (DSAU04). */
export function lineDeclaresIva(l: SupportDocLine): boolean {
  return l.ivaCents > 0;
}

/** Totales EXACTOS desde las líneas (enteros: nada se inventa). */
export function computeSupportDocTotals(lines: readonly SupportDocLine[]): SupportDocTotals {
  const lineExtensionCents = lines.reduce((a, l) => a + l.lineTotalCents, 0);
  const taxableBaseCents = lines.filter(lineDeclaresIva).reduce((a, l) => a + l.lineTotalCents, 0);
  const ivaCents = lines.reduce((a, l) => a + l.ivaCents, 0);
  const withholdingCents = lines.reduce(
    (a, l) => a + l.withholdings.reduce((s, w) => s + w.amountCents, 0),
    0,
  );
  return {
    lineExtensionCents,
    taxableBaseCents,
    ivaCents,
    payableCents: lineExtensionCents + ivaCents,
    withholdingCents,
  };
}

type Subtotal = { taxableCents: number; amountCents: number; pct: string };

function subtotalXml(schemeId: "01" | WithholdingSchemeId, s: Subtotal): string {
  return (
    `<cac:TaxSubtotal>` +
    `<cbc:TaxableAmount currencyID="COP">${A(s.taxableCents)}</cbc:TaxableAmount>` +
    `<cbc:TaxAmount currencyID="COP">${A(s.amountCents)}</cbc:TaxAmount>` +
    `<cac:TaxCategory><cbc:Percent>${s.pct}</cbc:Percent>` +
    `<cac:TaxScheme><cbc:ID>${schemeId}</cbc:ID><cbc:Name>${TAX_SCHEMES[schemeId]}</cbc:Name></cac:TaxScheme>` +
    `</cac:TaxCategory>` +
    `</cac:TaxSubtotal>`
  );
}

/** Un grupo (TaxTotal o WithholdingTaxTotal) con un TaxSubtotal por tarifa (DSAS01a, DSAT04). */
function groupXml(
  tag: "TaxTotal" | "WithholdingTaxTotal",
  schemeId: "01" | WithholdingSchemeId,
  subtotals: Subtotal[],
): string {
  const total = subtotals.reduce((a, s) => a + s.amountCents, 0);
  return (
    `<cac:${tag}>` +
    `<cbc:TaxAmount currencyID="COP">${A(total)}</cbc:TaxAmount>` +
    subtotals.map((s) => subtotalXml(schemeId, s)).join("") +
    `</cac:${tag}>`
  );
}

/** Agrupa por tarifa conservando el orden de aparición. */
function byPct(items: Subtotal[]): Subtotal[] {
  const map = new Map<string, Subtotal>();
  for (const it of items) {
    const acc = map.get(it.pct) ?? { taxableCents: 0, amountCents: 0, pct: it.pct };
    acc.taxableCents += it.taxableCents;
    acc.amountCents += it.amountCents;
    map.set(it.pct, acc);
  }
  return [...map.values()];
}

function lineIvaXml(l: SupportDocLine): string {
  if (!lineDeclaresIva(l)) return "";
  return groupXml("TaxTotal", "01", [
    { taxableCents: l.lineTotalCents, amountCents: l.ivaCents, pct: l.ivaPct },
  ]);
}

function lineWithholdingsXml(l: SupportDocLine): string {
  return (["05", "06"] as const)
    .map((schemeId) => {
      const ws = l.withholdings.filter((w) => w.schemeId === schemeId && w.amountCents > 0);
      if (ws.length === 0) return "";
      return groupXml(
        "WithholdingTaxTotal",
        schemeId,
        byPct(ws.map((w) => ({ taxableCents: w.taxableCents, amountCents: w.amountCents, pct: w.pct }))),
      );
    })
    .join("");
}

/** IVA y retenciones del DOCUMENTO: suma de los de las líneas, por tarifa. */
function documentTaxesXml(lines: readonly SupportDocLine[], withWithholdings: boolean): string {
  const iva = lines.filter(lineDeclaresIva);
  const parts: string[] = [];
  if (iva.length > 0) {
    parts.push(
      groupXml(
        "TaxTotal",
        "01",
        byPct(iva.map((l) => ({ taxableCents: l.lineTotalCents, amountCents: l.ivaCents, pct: l.ivaPct }))),
      ),
    );
  }
  if (withWithholdings) {
    for (const schemeId of ["05", "06"] as const) {
      const ws = lines.flatMap((l) => l.withholdings.filter((w) => w.schemeId === schemeId && w.amountCents > 0));
      if (ws.length === 0) continue;
      parts.push(
        groupXml(
          "WithholdingTaxTotal",
          schemeId,
          byPct(ws.map((w) => ({ taxableCents: w.taxableCents, amountCents: w.amountCents, pct: w.pct }))),
        ),
      );
    }
  }
  return parts.join("");
}

/** AccountingSupplierParty: el VENDEDOR no obligado (DSAJ01–DSAJ39). */
export function sellerXml(s: SupportDocSeller): string {
  const a = s.address;
  const address =
    a.kind === "resident"
      ? `<cbc:ID>${esc(a.cityCode)}</cbc:ID>` +
        `<cbc:CityName>${esc(a.cityName)}</cbc:CityName>` +
        `<cbc:PostalZone>${esc(a.postalZone)}</cbc:PostalZone>` +
        `<cbc:CountrySubentity>${esc(a.deptName)}</cbc:CountrySubentity>` +
        `<cbc:CountrySubentityCode>${esc(a.deptCode)}</cbc:CountrySubentityCode>` +
        `<cac:AddressLine><cbc:Line>${esc(a.line)}</cbc:Line></cac:AddressLine>` +
        `<cac:Country><cbc:IdentificationCode>CO</cbc:IdentificationCode>` +
        `<cbc:Name languageID="es">Colombia</cbc:Name></cac:Country>`
      : `<cbc:CityName>${esc(a.cityName)}</cbc:CityName>` +
        (a.line ? `<cac:AddressLine><cbc:Line>${esc(a.line)}</cbc:Line></cac:AddressLine>` : "") +
        `<cac:Country><cbc:IdentificationCode>${esc(a.countryCode)}</cbc:IdentificationCode>` +
        `<cbc:Name languageID="es">${esc(a.countryName)}</cbc:Name></cac:Country>`;
  const dv = s.dv != null && s.idSchemeName === "31" ? ` schemeID="${esc(s.dv)}"` : "";
  return (
    `<cac:AccountingSupplierParty>` +
    `<cbc:AdditionalAccountID>${s.personType}</cbc:AdditionalAccountID>` +
    `<cac:Party>` +
    `<cac:PhysicalLocation><cac:Address>${address}</cac:Address></cac:PhysicalLocation>` +
    `<cac:PartyTaxScheme>` +
    `<cbc:RegistrationName>${esc(s.name)}</cbc:RegistrationName>` +
    `<cbc:CompanyID ${AGENCY}${dv} schemeName="${esc(s.idSchemeName)}">${esc(s.companyId)}</cbc:CompanyID>` +
    `<cbc:TaxLevelCode>${esc(s.taxLevelCode)}</cbc:TaxLevelCode>` +
    // El vendedor no obligado no es responsable de IVA: "ZZ No aplica"
    // (tabla 16.2.5.2), como en los ejemplos oficiales.
    `<cac:TaxScheme><cbc:ID>ZZ</cbc:ID><cbc:Name>No aplica</cbc:Name></cac:TaxScheme>` +
    `</cac:PartyTaxScheme>` +
    `</cac:Party>` +
    `</cac:AccountingSupplierParty>`
  );
}

/** AccountingCustomerParty: el comercio que genera el DS (DSAK01–DSAK39). */
export function buyerXml(b: SupportDocBuyer): string {
  return (
    `<cac:AccountingCustomerParty>` +
    `<cbc:AdditionalAccountID>${b.personType}</cbc:AdditionalAccountID>` +
    `<cac:Party>` +
    `<cac:PartyTaxScheme>` +
    `<cbc:RegistrationName>${esc(b.name)}</cbc:RegistrationName>` +
    `<cbc:CompanyID ${AGENCY} schemeID="${esc(b.dv)}" schemeName="31">${esc(b.nit)}</cbc:CompanyID>` +
    `<cbc:TaxLevelCode>${esc(b.taxLevelCode)}</cbc:TaxLevelCode>` +
    `<cac:TaxScheme><cbc:ID>${b.taxSchemeId}</cbc:ID><cbc:Name>${b.taxSchemeId === "01" ? "IVA" : "No aplica"}</cbc:Name></cac:TaxScheme>` +
    `</cac:PartyTaxScheme>` +
    `</cac:Party>` +
    `</cac:AccountingCustomerParty>`
  );
}

function paymentMeansXml(p: SupportDocPaymentMeans, issueDate: string): string {
  return (
    `<cac:PaymentMeans>` +
    `<cbc:ID>${p.id}</cbc:ID>` +
    `<cbc:PaymentMeansCode>${esc(p.code)}</cbc:PaymentMeansCode>` +
    // DSAN04: con crédito el vencimiento es obligatorio; con contado es la
    // misma fecha de emisión (como en la factura).
    `<cbc:PaymentDueDate>${p.dueDate ?? issueDate}</cbc:PaymentDueDate>` +
    `</cac:PaymentMeans>`
  );
}

function itemAndPriceXml(l: SupportDocLine): string {
  return (
    `<cac:Item><cbc:Description>${esc(l.description)}</cbc:Description>` +
    `<cac:StandardItemIdentification>` +
    `<cbc:ID schemeID="999" schemeName="Estándar de adopción del contribuyente">${esc(l.itemCode)}</cbc:ID>` +
    `</cac:StandardItemIdentification>` +
    `</cac:Item>` +
    `<cac:Price>` +
    `<cbc:PriceAmount currencyID="COP">${A(l.unitPriceCents)}</cbc:PriceAmount>` +
    `<cbc:BaseQuantity unitCode="${esc(l.unitCode)}">1.000000</cbc:BaseQuantity>` +
    `</cac:Price>`
  );
}

function dianExtensions(opts: {
  resolution: DianResolution | null;
  buyer: SupportDocBuyer;
  softwareId: string;
  securityCode: string;
  qrUrl: string;
}): string {
  const r = opts.resolution;
  return (
    `<ext:UBLExtensions>` +
    `<ext:UBLExtension><ext:ExtensionContent>` +
    `<sts:DianExtensions>` +
    (r
      ? `<sts:InvoiceControl>` +
        `<sts:InvoiceAuthorization>${esc(r.number)}</sts:InvoiceAuthorization>` +
        `<sts:AuthorizationPeriod><cbc:StartDate>${r.startDate}</cbc:StartDate><cbc:EndDate>${r.endDate}</cbc:EndDate></sts:AuthorizationPeriod>` +
        `<sts:AuthorizedInvoices><sts:Prefix>${esc(r.prefix)}</sts:Prefix><sts:From>${r.from}</sts:From><sts:To>${r.to}</sts:To></sts:AuthorizedInvoices>` +
        `</sts:InvoiceControl>`
      : "") +
    `<sts:InvoiceSource><cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode></sts:InvoiceSource>` +
    // Software propio: el "proveedor tecnológico" es el mismo comercio
    // (adquiriente), con su NIT y DV (DSAB19–DSAB23).
    `<sts:SoftwareProvider>` +
    `<sts:ProviderID ${AGENCY} schemeID="${esc(opts.buyer.dv)}" schemeName="31">${esc(opts.buyer.nit)}</sts:ProviderID>` +
    `<sts:SoftwareID ${AGENCY}>${esc(opts.softwareId)}</sts:SoftwareID>` +
    `</sts:SoftwareProvider>` +
    `<sts:SoftwareSecurityCode ${AGENCY}>${opts.securityCode}</sts:SoftwareSecurityCode>` +
    `<sts:AuthorizationProvider><sts:AuthorizationProviderID ${AGENCY} schemeID="4" schemeName="31">800197268</sts:AuthorizationProviderID></sts:AuthorizationProvider>` +
    `<sts:QRCode>${esc(opts.qrUrl)}</sts:QRCode>` +
    `</sts:DianExtensions>` +
    `</ext:ExtensionContent></ext:UBLExtension>` +
    `<ext:UBLExtension><ext:ExtensionContent></ext:ExtensionContent></ext:UBLExtension>` +
    `</ext:UBLExtensions>`
  );
}

const NAMESPACES =
  `xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ` +
  `xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" ` +
  `xmlns:ds="http://www.w3.org/2000/09/xmldsig#" ` +
  `xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" ` +
  `xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1" ` +
  `xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" ` +
  `xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#" ` +
  `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;

const CURRENCY =
  `<cbc:DocumentCurrencyCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listID="ISO 4217 Alpha">COP</cbc:DocumentCurrencyCode>`;

function monetaryTotalXml(t: SupportDocTotals): string {
  return (
    `<cac:LegalMonetaryTotal>` +
    `<cbc:LineExtensionAmount currencyID="COP">${A(t.lineExtensionCents)}</cbc:LineExtensionAmount>` +
    // DSAU04: base imponible = Σ TaxableAmount de las líneas con IVA.
    `<cbc:TaxExclusiveAmount currencyID="COP">${A(t.taxableBaseCents)}</cbc:TaxExclusiveAmount>` +
    `<cbc:TaxInclusiveAmount currencyID="COP">${A(t.payableCents)}</cbc:TaxInclusiveAmount>` +
    `<cbc:AllowanceTotalAmount currencyID="COP">0.00</cbc:AllowanceTotalAmount>` +
    `<cbc:PayableAmount currencyID="COP">${A(t.payableCents)}</cbc:PayableAmount>` +
    `</cac:LegalMonetaryTotal>`
  );
}

function identity(i: CommonInput, totals: SupportDocTotals) {
  const cuds = computeCuds({
    documentNumber: i.documentNumber,
    issueDate: i.issueDate,
    issueTime: i.issueTime,
    lineExtensionAmount: A(totals.lineExtensionCents),
    ivaAmount: A(totals.ivaCents),
    payableAmount: A(totals.payableCents),
    sellerId: i.seller.companyId,
    buyerNit: i.buyer.nit,
    softwarePin: i.softwarePin,
    environment: i.environment,
  });
  return {
    cuds,
    qrUrl: supportDocQrUrl(cuds, i.environment),
    securityCode: softwareSecurityCode(i.softwareId, i.softwarePin, i.documentNumber),
  };
}

function assertBuildable(i: CommonInput): void {
  if (i.lines.length === 0) throw new Error("support_doc_without_lines");
  if (!/^[A-Za-z0-9]+$/.test(i.documentNumber)) throw new Error("support_doc_invalid_number");
  for (const l of i.lines) {
    if (!(l.quantity > 0) || l.lineTotalCents < 0 || l.ivaCents < 0) {
      throw new Error("support_doc_invalid_line");
    }
  }
}

/** Documento soporte: Invoice con InvoiceTypeCode 05. */
export function buildSupportDocumentXml(i: SupportDocXmlInput): BuiltSupportDoc {
  assertBuildable(i);
  const totals = computeSupportDocTotals(i.lines);
  const { cuds, qrUrl, securityCode } = identity(i, totals);
  const linesXml = i.lines
    .map(
      (l, idx) =>
        `<cac:InvoiceLine>` +
        `<cbc:ID>${idx + 1}</cbc:ID>` +
        `<cbc:InvoicedQuantity unitCode="${esc(l.unitCode)}">${l.quantity}.000000</cbc:InvoicedQuantity>` +
        `<cbc:LineExtensionAmount currencyID="COP">${A(l.lineTotalCents)}</cbc:LineExtensionAmount>` +
        `<cac:InvoicePeriod>` +
        `<cbc:StartDate>${l.purchaseDate}</cbc:StartDate>` +
        `<cbc:DescriptionCode>${l.generationForm}</cbc:DescriptionCode>` +
        `<cbc:Description>${GENERATION_FORMS[l.generationForm]}</cbc:Description>` +
        `</cac:InvoicePeriod>` +
        lineIvaXml(l) +
        lineWithholdingsXml(l) +
        itemAndPriceXml(l) +
        `</cac:InvoiceLine>`,
    )
    .join("");

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ${NAMESPACES}>` +
    dianExtensions({ resolution: i.resolution, buyer: i.buyer, softwareId: i.softwareId, securityCode, qrUrl }) +
    `<cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>` +
    `<cbc:CustomizationID>${i.customizationId}</cbc:CustomizationID>` +
    `<cbc:ProfileID>${DS_PROFILE_ID}</cbc:ProfileID>` +
    `<cbc:ProfileExecutionID>${i.environment}</cbc:ProfileExecutionID>` +
    `<cbc:ID>${esc(i.documentNumber)}</cbc:ID>` +
    `<cbc:UUID schemeID="${i.environment}" schemeName="${CUDS_SCHEME_NAME}">${cuds}</cbc:UUID>` +
    `<cbc:IssueDate>${i.issueDate}</cbc:IssueDate>` +
    `<cbc:IssueTime>${i.issueTime}</cbc:IssueTime>` +
    `<cbc:InvoiceTypeCode>${DS_INVOICE_TYPE_CODE}</cbc:InvoiceTypeCode>` +
    (i.note ? `<cbc:Note>${esc(i.note)}</cbc:Note>` : "") +
    CURRENCY +
    `<cbc:LineCountNumeric>${i.lines.length}</cbc:LineCountNumeric>` +
    sellerXml(i.seller) +
    buyerXml(i.buyer) +
    paymentMeansXml(i.paymentMeans, i.issueDate) +
    documentTaxesXml(i.lines, true) +
    monetaryTotalXml(totals) +
    linesXml +
    `</Invoice>`;
  return { xml, cuds, qrUrl, securityCode, totals };
}

/** Nota de ajuste al documento soporte: CreditNote con CreditNoteTypeCode 95. */
export function buildAdjustmentNoteXml(i: AdjustmentNoteXmlInput): BuiltSupportDoc {
  assertBuildable(i);
  // La NAS no informa retenciones (el anexo no define WithholdingTaxTotal en
  // §8.2): se calcula y se arma sin ellas.
  const lines = i.lines.map((l) => ({ ...l, withholdings: [] }));
  const totals = computeSupportDocTotals(lines);
  const { cuds, qrUrl, securityCode } = identity({ ...i, lines }, totals);
  const linesXml = lines
    .map(
      (l, idx) =>
        `<cac:CreditNoteLine>` +
        `<cbc:ID>${idx + 1}</cbc:ID>` +
        `<cbc:CreditedQuantity unitCode="${esc(l.unitCode)}">${l.quantity}.000000</cbc:CreditedQuantity>` +
        `<cbc:LineExtensionAmount currencyID="COP">${A(l.lineTotalCents)}</cbc:LineExtensionAmount>` +
        lineIvaXml(l) +
        itemAndPriceXml(l) +
        `</cac:CreditNoteLine>`,
    )
    .join("");
  const description = i.reasonText.trim() || ADJUSTMENT_REASONS[i.reasonCode];

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" ${NAMESPACES}>` +
    dianExtensions({ resolution: null, buyer: i.buyer, softwareId: i.softwareId, securityCode, qrUrl }) +
    `<cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>` +
    `<cbc:CustomizationID>${i.customizationId}</cbc:CustomizationID>` +
    `<cbc:ProfileID>${NAS_PROFILE_ID}</cbc:ProfileID>` +
    `<cbc:ProfileExecutionID>${i.environment}</cbc:ProfileExecutionID>` +
    `<cbc:ID>${esc(i.documentNumber)}</cbc:ID>` +
    `<cbc:UUID schemeID="${i.environment}" schemeName="${CUDS_SCHEME_NAME}">${cuds}</cbc:UUID>` +
    `<cbc:IssueDate>${i.issueDate}</cbc:IssueDate>` +
    `<cbc:IssueTime>${i.issueTime}</cbc:IssueTime>` +
    `<cbc:CreditNoteTypeCode>${NAS_CREDIT_NOTE_TYPE_CODE}</cbc:CreditNoteTypeCode>` +
    (i.note ? `<cbc:Note>${esc(i.note)}</cbc:Note>` : "") +
    CURRENCY +
    `<cbc:LineCountNumeric>${lines.length}</cbc:LineCountNumeric>` +
    // NSBF02 (ReferenceID) es opcional y numérico de 1 a 4 dígitos (una
    // sección del documento): no se informa; la referencia va completa en
    // cac:BillingReference.
    `<cac:DiscrepancyResponse>` +
    `<cbc:ResponseCode>${i.reasonCode}</cbc:ResponseCode>` +
    `<cbc:Description>${esc(description)}</cbc:Description>` +
    `</cac:DiscrepancyResponse>` +
    `<cac:BillingReference><cac:InvoiceDocumentReference>` +
    `<cbc:ID>${esc(i.reference.documentNumber)}</cbc:ID>` +
    `<cbc:UUID schemeName="${CUDS_SCHEME_NAME}">${esc(i.reference.cuds)}</cbc:UUID>` +
    `<cbc:IssueDate>${i.reference.issueDate}</cbc:IssueDate>` +
    `</cac:InvoiceDocumentReference></cac:BillingReference>` +
    sellerXml(i.seller) +
    buyerXml(i.buyer) +
    paymentMeansXml(i.paymentMeans, i.issueDate) +
    documentTaxesXml(lines, false) +
    monetaryTotalXml(totals) +
    linesXml +
    `</CreditNote>`;
  return { xml, cuds, qrUrl, securityCode, totals };
}
