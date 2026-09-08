// Builder UBL 2.1 perfil DIAN — factura electrónica de venta (ERP B1.3).
//
// Genera el XML SIN firmar (deja el segundo ExtensionContent vacío como
// slot para signXmlDian de B1.2), con CUFE calculado, QR y
// SoftwareSecurityCode. Función pura: recibe todo resuelto (emisor,
// adquirente, líneas con impuestos ya calculados) — el mapeo desde la
// Order/configuración del comercio llega en B1.6. Estructura según el
// Anexo Técnico 1.9 (público).
import { createHash } from "crypto";
import {
  centsToDianAmount,
  computeCufe,
  dianQrUrl,
  type CufeInputs,
} from "@/lib/dian/crypto";

// ── Tipos de entrada ────────────────────────────────────────────────────────

export type DianParty = {
  /** Razón social / nombre. */
  name: string;
  /** NIT o documento SIN dígito de verificación. */
  companyId: string;
  /** Dígito de verificación (solo NIT). */
  dv?: string | null;
  /**
   * Tipo de documento (anexo 6.2.1): "31" NIT, "13" cédula.
   * Consumidor final: companyId 222222222222, scheme "13".
   */
  idSchemeName: "31" | "13";
  /** Responsabilidades fiscales (anexo 6.2.4): "O-13", "O-15", "R-99-PN"… */
  taxLevelCode: string;
  /** Régimen: "48" responsable de IVA, "49" no responsable. */
  taxRegimeCode: "48" | "49";
  /**
   * Persona jurídica "1" / natural "2" (cbc:AdditionalAccountID). Con "2"
   * el Anexo Técnico obliga a informar cac:PartyIdentification (FAK61) —
   * ver partyXml. El consumidor final SIEMPRE es "2".
   */
  personType: "1" | "2";
  address?: {
    /** Código municipio DANE ("11001") y nombre ("Bogotá, D.C."). */
    cityCode: string;
    cityName: string;
    /** Departamento: código ("11") y nombre ("Bogotá"). */
    deptCode: string;
    deptName: string;
    line: string;
    postalZone?: string | null;
  } | null;
  email?: string | null;
  phone?: string | null;
};

export type DianLine = {
  description: string;
  /** Cantidad (entera en restaurantes). */
  quantity: number;
  /** Precio unitario SIN impuesto, en centavos. */
  unitPriceCents: number;
  /** Total de línea SIN impuesto (qty × unit, ya redondeado), en centavos. */
  lineTotalCents: number;
  /** Impuesto de la línea en centavos (0 si no grava). */
  taxCents: number;
  /** Tarifa ("8.00", "19.00", "0.00"). */
  taxPct: string;
  /** "01" IVA · "04" impoconsumo (INC). */
  taxSchemeId: "01" | "04";
  /**
   * Código del bien/servicio para StandardItemIdentification (regla
   * FAZ09: el grupo de identificación del ítem es obligatorio). Si no
   * viene, se usa el número de línea.
   */
  itemCode?: string | null;
};

export type DianResolution = {
  /** Número de la resolución DIAN ("18760000001"). */
  number: string;
  /** Vigencia "YYYY-MM-DD". */
  startDate: string;
  endDate: string;
  prefix: string;
  from: number;
  to: number;
};

export type DianInvoiceInput = {
  environment: "1" | "2";
  softwareId: string;
  softwarePin: string;
  technicalKey: string;
  resolution: DianResolution;
  /** Número COMPLETO del documento (prefijo + consecutivo). */
  invoiceNumber: string;
  /** "YYYY-MM-DD" y "HH:mm:ss-05:00" (hora Colombia). */
  issueDate: string;
  issueTime: string;
  supplier: DianParty;
  customer: DianParty;
  lines: DianLine[];
  /** Medio de pago (anexo 6.3.4): "10" efectivo, "48" tarjeta, "47" transferencia. */
  paymentMeansCode: string;
  /** Nota opcional (se incluye como cbc:Note). */
  note?: string | null;
};

export type DianTotals = {
  lineExtensionCents: number;
  /**
   * Base imponible del documento = Σ de las bases de las líneas que
   * DECLARAN impuesto. NO es lo mismo que lineExtensionCents: una línea
   * excluida suma al bruto pero no aporta base imponible.
   */
  taxableBaseCents: number;
  taxIvaCents: number;
  taxIncCents: number;
  taxIcaCents: number;
  payableCents: number;
};

/**
 * ¿La línea declara impuesto? Es el ÚNICO criterio: la misma función
 * decide si se emite el cac:TaxTotal de la línea y si su base entra a la
 * base imponible del documento. Tenerlo en un solo lugar es lo que evita
 * que el total y el detalle se desincronicen (regla FAU04).
 */
export function lineDeclaresTax(l: DianLine): boolean {
  return l.taxCents > 0;
}

/** Totales derivados EXACTOS de las líneas (enteros — nada se inventa). */
export function computeDianTotals(lines: DianLine[]): DianTotals {
  const lineExtensionCents = lines.reduce((a, l) => a + l.lineTotalCents, 0);
  const taxableBaseCents = lines
    .filter(lineDeclaresTax)
    .reduce((a, l) => a + l.lineTotalCents, 0);
  const taxIvaCents = lines
    .filter((l) => l.taxSchemeId === "01")
    .reduce((a, l) => a + l.taxCents, 0);
  const taxIncCents = lines
    .filter((l) => l.taxSchemeId === "04")
    .reduce((a, l) => a + l.taxCents, 0);
  return {
    lineExtensionCents,
    taxableBaseCents,
    taxIvaCents,
    taxIncCents,
    taxIcaCents: 0, // ICA no aplica en venta de restaurante
    payableCents: lineExtensionCents + taxIvaCents + taxIncCents,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const A = centsToDianAmount; // centavos → "1234.56"

/** SoftwareSecurityCode = SHA-384(softwareId + pin + número del documento). */
export function softwareSecurityCode(
  softwareId: string,
  pin: string,
  invoiceNumber: string,
): string {
  return createHash("sha384")
    .update(softwareId + pin + invoiceNumber, "utf8")
    .digest("hex");
}

const TAX_NAME: Record<string, string> = { "01": "IVA", "04": "INC" };

function partyXml(
  kind: "supplier" | "customer",
  p: DianParty,
  /** Prefijo de la resolución — sólo para el emisor (ver abajo). */
  invoicePrefix?: string,
): string {
  const tag =
    kind === "supplier" ? "AccountingSupplierParty" : "AccountingCustomerParty";
  const roleTag = kind === "supplier" ? "SupplierAssignedAccountID" : "";
  void roleTag;
  const addr = p.address
    ? `<cac:PhysicalLocation><cac:Address>` +
      `<cbc:ID>${esc(p.address.cityCode)}</cbc:ID>` +
      `<cbc:CityName>${esc(p.address.cityName)}</cbc:CityName>` +
      (p.address.postalZone ? `<cbc:PostalZone>${esc(p.address.postalZone)}</cbc:PostalZone>` : "") +
      `<cbc:CountrySubentity>${esc(p.address.deptName)}</cbc:CountrySubentity>` +
      `<cbc:CountrySubentityCode>${esc(p.address.deptCode)}</cbc:CountrySubentityCode>` +
      `<cac:AddressLine><cbc:Line>${esc(p.address.line)}</cbc:Line></cac:AddressLine>` +
      `<cac:Country><cbc:IdentificationCode>CO</cbc:IdentificationCode>` +
      `<cbc:Name languageID="es">Colombia</cbc:Name></cac:Country>` +
      `</cac:Address></cac:PhysicalLocation>`
    : "";
  // El DV va en @schemeID del CompanyID y SOLO tiene sentido para NIT
  // (schemeName 31). Sin él la DIAN rechaza con FAJ24a/FAJ47 (emisor).
  const dvAttr = p.dv != null && p.idSchemeName === "31" ? ` schemeID="${esc(p.dv)}"` : "";
  // FAK61 (rechazo): «Si el valor de AdditionalAccountID es igual a "2" y el
  // grupo no es informado». El grupo que exige el Anexo Técnico 1.9
  // (Resolución 000165/2023, pág. 47 y tabla de reglas pág. 401) NO es
  // cac:Person —que sólo existe en el ApplicationResponse del acuse—, sino
  // cac:PartyIdentification: FAK61 el grupo, FAK62 el cbc:ID
  // ("222222222222" para consumidor final), FAK63 @schemeName (tipo de
  // documento, "13" para consumidor final) y FAK64 @schemeID (el DV, y sólo
  // cuando el documento es NIT). Va PRIMERO dentro de cac:Party: es el orden
  // de la secuencia del esquema UBL 2.1 y el del anexo (FAK61 antes de
  // FAK05/PartyName); fuera de sitio el XSD no valida.
  const partyIdentification =
    p.personType === "2"
      ? `<cac:PartyIdentification>` +
        `<cbc:ID${dvAttr} schemeName="${p.idSchemeName}" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${esc(p.companyId)}</cbc:ID>` +
        `</cac:PartyIdentification>`
      : "";
  return (
    `<cac:${tag}>` +
    `<cbc:AdditionalAccountID>${p.personType}</cbc:AdditionalAccountID>` +
    `<cac:Party>` +
    partyIdentification +
    `<cac:PartyName><cbc:Name>${esc(p.name)}</cbc:Name></cac:PartyName>` +
    addr +
    `<cac:PartyTaxScheme>` +
    `<cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>` +
    `<cbc:CompanyID${dvAttr} schemeName="${p.idSchemeName}" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${esc(p.companyId)}</cbc:CompanyID>` +
    `<cbc:TaxLevelCode>${esc(p.taxLevelCode)}</cbc:TaxLevelCode>` +
    `<cac:TaxScheme><cbc:ID>${p.taxRegimeCode === "48" ? "01" : "ZZ"}</cbc:ID><cbc:Name>${p.taxRegimeCode === "48" ? "IVA" : "No aplica"}</cbc:Name></cac:TaxScheme>` +
    `</cac:PartyTaxScheme>` +
    `<cac:PartyLegalEntity>` +
    `<cbc:RegistrationName>${esc(p.name)}</cbc:RegistrationName>` +
    `<cbc:CompanyID${dvAttr} schemeName="${p.idSchemeName}" schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${esc(p.companyId)}</cbc:CompanyID>` +
    // FAB10a (rechazo) y FAJ50: "el prefijo de numeración no es igual al
    // código de la sucursal correspondiente a este punto de facturación".
    // El código de sucursal se declara acá, en CorporateRegistrationScheme,
    // y NO se estaba mandando: la DIAN comparaba el prefijo contra nada y la
    // regla no podía cumplirse nunca. Sólo aplica al emisor.
    (kind === "supplier" && invoicePrefix
      ? `<cac:CorporateRegistrationScheme><cbc:ID>${esc(invoicePrefix)}</cbc:ID></cac:CorporateRegistrationScheme>`
      : "") +
    `</cac:PartyLegalEntity>` +
    (p.email || p.phone
      ? `<cac:Contact>` +
        (p.phone ? `<cbc:Telephone>${esc(p.phone)}</cbc:Telephone>` : "") +
        (p.email ? `<cbc:ElectronicMail>${esc(p.email)}</cbc:ElectronicMail>` : "") +
        `</cac:Contact>`
      : "") +
    `</cac:Party>` +
    `</cac:${tag}>`
  );
}

type TaxSubtotal = { taxCents: number; taxableCents: number; pct: string };

/**
 * cac:TaxTotal con un cac:TaxSubtotal POR TARIFA. Antes se emitía un
 * único subtotal con la tarifa de la primera línea del grupo: con dos
 * tarifas del mismo impuesto (IVA 19% y 5%) la base declarada no
 * coincidía con la de las líneas.
 */
function taxTotalXml(schemeId: "01" | "04", subtotals: TaxSubtotal[]): string {
  const taxCents = subtotals.reduce((a, s) => a + s.taxCents, 0);
  return (
    `<cac:TaxTotal>` +
    `<cbc:TaxAmount currencyID="COP">${A(taxCents)}</cbc:TaxAmount>` +
    subtotals
      .map(
        (s) =>
          `<cac:TaxSubtotal>` +
          `<cbc:TaxableAmount currencyID="COP">${A(s.taxableCents)}</cbc:TaxableAmount>` +
          `<cbc:TaxAmount currencyID="COP">${A(s.taxCents)}</cbc:TaxAmount>` +
          `<cac:TaxCategory><cbc:Percent>${s.pct}</cbc:Percent>` +
          `<cac:TaxScheme><cbc:ID>${schemeId}</cbc:ID><cbc:Name>${TAX_NAME[schemeId]}</cbc:Name></cac:TaxScheme>` +
          `</cac:TaxCategory>` +
          `</cac:TaxSubtotal>`,
      )
      .join("") +
    `</cac:TaxTotal>`
  );
}

// ── Builder ─────────────────────────────────────────────────────────────────

export type BuiltDianInvoice = {
  xml: string;
  cufe: string;
  qrUrl: string;
  securityCode: string;
  totals: DianTotals;
};

export function buildDianInvoiceXml(i: DianInvoiceInput): BuiltDianInvoice {
  const totals = computeDianTotals(i.lines);
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
    key: i.technicalKey,
    environment: i.environment,
  };
  const cufe = computeCufe(cufeInputs);
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
      (l) => l.taxSchemeId === schemeId && lineDeclaresTax(l),
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
        `<cac:InvoiceLine>` +
        `<cbc:ID>${idx + 1}</cbc:ID>` +
        `<cbc:InvoicedQuantity unitCode="EA">${l.quantity}.000000</cbc:InvoicedQuantity>` +
        `<cbc:LineExtensionAmount currencyID="COP">${A(l.lineTotalCents)}</cbc:LineExtensionAmount>` +
        (lineDeclaresTax(l)
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
        `</cac:InvoiceLine>`
      );
    })
    .join("");

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>` +
    `<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ` +
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
    `<sts:InvoiceControl>` +
    `<sts:InvoiceAuthorization>${esc(i.resolution.number)}</sts:InvoiceAuthorization>` +
    `<sts:AuthorizationPeriod><cbc:StartDate>${i.resolution.startDate}</cbc:StartDate><cbc:EndDate>${i.resolution.endDate}</cbc:EndDate></sts:AuthorizationPeriod>` +
    `<sts:AuthorizedInvoices><sts:Prefix>${esc(i.resolution.prefix)}</sts:Prefix><sts:From>${i.resolution.from}</sts:From><sts:To>${i.resolution.to}</sts:To></sts:AuthorizedInvoices>` +
    `</sts:InvoiceControl>` +
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
    `<cbc:CustomizationID>10</cbc:CustomizationID>` +
    // FAD03: la DIAN compara el literal EXACTO, con mayúsculas incluidas.
    `<cbc:ProfileID>DIAN 2.1: Factura Electrónica de Venta</cbc:ProfileID>` +
    `<cbc:ProfileExecutionID>${i.environment}</cbc:ProfileExecutionID>` +
    `<cbc:ID>${esc(i.invoiceNumber)}</cbc:ID>` +
    `<cbc:UUID schemeID="${i.environment}" schemeName="CUFE-SHA384">${cufe}</cbc:UUID>` +
    `<cbc:IssueDate>${i.issueDate}</cbc:IssueDate>` +
    `<cbc:IssueTime>${i.issueTime}</cbc:IssueTime>` +
    `<cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>` +
    (i.note ? `<cbc:Note>${esc(i.note)}</cbc:Note>` : "") +
    `<cbc:DocumentCurrencyCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listID="ISO 4217 Alpha">COP</cbc:DocumentCurrencyCode>` +
    `<cbc:LineCountNumeric>${i.lines.length}</cbc:LineCountNumeric>` +
    partyXml("supplier", i.supplier, i.resolution.prefix) +
    partyXml("customer", i.customer) +
    `<cac:PaymentMeans><cbc:ID>1</cbc:ID><cbc:PaymentMeansCode>${esc(i.paymentMeansCode)}</cbc:PaymentMeansCode><cbc:PaymentDueDate>${i.issueDate}</cbc:PaymentDueDate><cbc:PaymentID>1</cbc:PaymentID></cac:PaymentMeans>` +
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
    `</Invoice>`;

  return { xml, cufe, qrUrl, securityCode, totals };
}

/**
 * Reparte el precio de carta (IMPUESTO INCLUIDO, como se muestra al
 * comensal) en base + impuesto por línea — la convención de los
 * restaurantes CO. pctTimes100: 800 = 8%, 1900 = 19%. Enteros exactos:
 * base = round(bruto / (1 + pct)), impuesto = bruto − base.
 */
export function splitTaxIncludedCents(
  grossCents: number,
  pctTimes100: number,
): { baseCents: number; taxCents: number } {
  if (pctTimes100 <= 0) return { baseCents: grossCents, taxCents: 0 };
  const baseCents = Math.round((grossCents * 10000) / (10000 + pctTimes100));
  return { baseCents, taxCents: grossCents - baseCents };
}
