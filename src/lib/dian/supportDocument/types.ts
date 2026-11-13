// Tipos del documento soporte (DS) y su nota de ajuste (NAS). Puros: los
// comparten el builder del XML, la emisión, la representación gráfica y la
// pantalla.
import type { DianResolution } from "@/lib/dian/ubl";
import type { AdjustmentReasonCode, GenerationForm, WithholdingSchemeId } from "./constants";

export type SupportDocKind = "support_document" | "adjustment_note";
export type SupportDocSourceType = "expense" | "purchase_order";

/** Dirección del vendedor residente (DSAJ08: conjunto completo con CustomizationID 10). */
export type ResidentAddress = {
  kind: "resident";
  /** Municipio DANE, 5 dígitos (tabla 16.4.3). */
  cityCode: string;
  cityName: string;
  /** Código postal de la tabla 16.4.4. */
  postalZone: string;
  deptCode: string;
  deptName: string;
  /** Dirección sin ciudad ni departamento (DSAJ14). */
  line: string;
};

/** Dirección del vendedor no residente (DSAJ08: CityName + país con CustomizationID 11). */
export type ForeignAddress = {
  kind: "foreign";
  cityName: string;
  /** ISO 3166 alfa-2 de la tabla 16.4.1. */
  countryCode: string;
  /** "Nombre común" de la tabla 16.4.1 (DSAJ17). */
  countryName: string;
  line: string | null;
};

/** Vendedor: el sujeto NO obligado a facturar (AccountingSupplierParty). */
export type SupportDocSeller = {
  /** Tabla 16.2.3: "1" persona jurídica · "2" persona natural. */
  personType: "1" | "2";
  name: string;
  /** Identificación SIN DV (residente: solo dígitos). */
  companyId: string;
  /** DV (solo con schemeName "31"). */
  dv: string | null;
  /** Tabla 16.2.1: residente siempre "31". */
  idSchemeName: string;
  /** Tabla 16.2.5.1, separadas por ";". */
  taxLevelCode: string;
  address: ResidentAddress | ForeignAddress;
};

/** Adquiriente: el comercio que genera el DS (AccountingCustomerParty). */
export type SupportDocBuyer = {
  personType: "1" | "2";
  name: string;
  /** NIT sin DV. */
  nit: string;
  dv: string;
  taxLevelCode: string;
  /** Tabla 16.2.5.2: "01" IVA · "ZZ" No aplica. */
  taxSchemeId: "01" | "ZZ";
};

/** Retención practicada por el adquiriente (cac:WithholdingTaxTotal). */
export type SupportDocWithholding = {
  /** "05" ReteIVA · "06" ReteRenta (tabla 16.2.2). */
  schemeId: WithholdingSchemeId;
  /** Base: la de la línea (ReteRenta) o su IVA (ReteIVA, DSAY05). */
  taxableCents: number;
  amountCents: number;
  /** Tarifa con 2 decimales ("2.50", "15.00"). */
  pct: string;
};

export type SupportDocLine = {
  description: string;
  quantity: number;
  /** Tabla 16.3.5.1 ("94" = unidad). */
  unitCode: string;
  unitPriceCents: number;
  /** Valor de la línea SIN impuestos (base). */
  lineTotalCents: number;
  /** IVA de la línea (0 si no grava). */
  ivaCents: number;
  /** Tarifa de IVA "0.00" | "5.00" | "19.00". */
  ivaPct: string;
  /** StandardItemIdentification (DSAZ09, obligatorio), esquema 999. */
  itemCode: string;
  /** Fecha de la compra (InvoicePeriod/StartDate, DSFC02). */
  purchaseDate: string;
  /** Forma de generación (DSFC03): 1 por operación · 2 acumulado semanal. */
  generationForm: GenerationForm;
  withholdings: SupportDocWithholding[];
};

/** cac:PaymentMeans (DSAN01–DSAN04): forma 1 contado · 2 crédito. */
export type SupportDocPaymentMeans = {
  id: "1" | "2";
  /** Tabla 16.3.4.2 ("1" instrumento no definido, "10" efectivo…). */
  code: string;
  /** "YYYY-MM-DD"; obligatorio con crédito (DSAN04). */
  dueDate: string | null;
};

/** Documento soporte que ajusta una nota (cac:BillingReference). */
export type SupportDocReference = {
  documentNumber: string;
  cuds: string;
  issueDate: string;
};

/**
 * Retención registrada que NO viaja en el XML: ReteICA no existe en el anexo
 * (`not_in_annex`); una base o tarifa que la DIAN no cuadraría
 * (`base_mismatch`, `rate_mismatch`). Informar retenciones es opcional
 * (0..N): la contabilidad del gasto o la compra no cambia.
 */
export type UntransmittedWithholding = {
  kind: "retefuente" | "reteiva" | "reteica";
  amountCents: number;
  reason: "not_in_annex" | "base_mismatch" | "rate_mismatch";
};

/**
 * Foto de lo que se transmite. Se guarda al numerar y es la fuente de la
 * representación gráfica; un reenvío tras un rechazo la vuelve a armar desde
 * el gasto o la compra (ya corregidos) con el MISMO número.
 */
export type SupportDocSnapshot = {
  version: 1;
  kind: SupportDocKind;
  customizationId: "10" | "11";
  seller: SupportDocSeller;
  buyer: SupportDocBuyer;
  lines: SupportDocLine[];
  paymentMeans: SupportDocPaymentMeans;
  note: string | null;
  /** DS: autorización de numeración que va en InvoiceControl. */
  resolution: DianResolution | null;
  /** NAS: documento soporte ajustado, concepto y descripción. */
  reference: SupportDocReference | null;
  reasonCode: AdjustmentReasonCode | null;
  reasonText: string | null;
  source: {
    type: SupportDocSourceType;
    id: string;
    /** "G-0012", "OC-0007" o el número de la factura del proveedor. */
    label: string | null;
    /** Fecha de la operación "YYYY-MM-DD" (Colombia). */
    operationDate: string;
  };
  untransmittedWithholdings: UntransmittedWithholding[];
  /** Fecha y hora declaradas en el último XML firmado. */
  issueDate: string | null;
  issueTime: string | null;
};

export type SupportDocTotals = {
  lineExtensionCents: number;
  /** Σ bases de las líneas que declaran IVA (DSAU04). */
  taxableBaseCents: number;
  ivaCents: number;
  /** LineExtension + IVA = PayableAmount (las retenciones no lo afectan, §14.3.1). */
  payableCents: number;
  /** Σ retenciones transmitidas (informativo: no restan del PayableAmount). */
  withholdingCents: number;
};
