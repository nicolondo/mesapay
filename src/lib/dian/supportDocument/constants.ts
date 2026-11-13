// Literales del documento soporte en adquisiciones efectuadas a sujetos no
// obligados a expedir factura de venta o documento equivalente (DS) y de su
// nota de ajuste (NAS).
//
// Fuente: Anexo Técnico de Documento Soporte v1.1, adoptado por la
// Resolución DIAN 000167 de 30-dic-2021 (art. 17, parágrafo) y mantenido por
// la Resolución Única 000227 de 2025 (art. 1.5.2.5.1):
// https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Documento-Soporte-No-Obligados.pdf
// Las páginas citadas son las impresas en el anexo ("Página N de 267").
//
// Son literales FISCALES del XML (la DIAN los compara tal cual): no son texto
// de la interfaz y no pasan por i18n.

/** DSAD03 (pág. 30): ProfileID del DS. Con el punto final. */
export const DS_PROFILE_ID =
  "DIAN 2.1: documento soporte en adquisiciones efectuadas a no obligados a facturar.";

/**
 * NSAD03 (pág. 76): ProfileID de la nota de ajuste. El literal de la regla y
 * el ejemplo oficial de la caja de herramientas (`NotaDeAjuste.xml`) lo
 * traen con un ESPACIO al final; se respeta tal cual. Es lo primero que hay
 * que mirar si habilitación rechaza con NSAD03.
 */
export const NAS_PROFILE_ID =
  "DIAN 2.1: Nota de ajuste al documento soporte en adquisiciones efectuadas a sujetos no obligados a expedir factura o documento equivalente ";

/** DSAD12 / tabla 16.1.3 (pág. 219): tipo de documento. */
export const DS_INVOICE_TYPE_CODE = "05";
/** NSAD12 / tabla 16.1.3: tipo de la nota de ajuste. */
export const NAS_CREDIT_NOTE_TYPE_CODE = "95";

/** DSAD02 / tabla 16.1.4.1 (pág. 219): procedencia del vendedor. */
export const CUSTOMIZATION_RESIDENT = "10";
export const CUSTOMIZATION_NON_RESIDENT = "11";

/** DSAD08 / tabla 16.1.2.1: algoritmo del identificador único. */
export const CUDS_SCHEME_NAME = "CUDS-SHA384";

/**
 * Tabla 16.1.6 (pág. 220): forma de generación y transmisión (arts. 2 y 10
 * de la Res. 000167). Va en cada línea, en cac:InvoicePeriod (DSFC01–DSFC04).
 */
export const GENERATION_FORMS = {
  "1": "Por operación",
  "2": "Acumulado semanal",
} as const;
export type GenerationForm = keyof typeof GENERATION_FORMS;

/**
 * DSFC02c (pág. 58 y 158): con «Acumulado semanal» se rechaza la línea cuyo
 * StartDate sea "menor a 6 días calendario" del SigningTime. Se acepta
 * hasta 6 días antes de la firma; más viejo no se puede transmitir.
 */
export const WEEKLY_MAX_DAYS = 6;

/**
 * Tabla 16.2.4 (pág. 220) — conceptos de corrección de la nota de ajuste.
 * Literales de la lista `ConceptoNotaAjuste-2.1.gc` de la caja de
 * herramientas (el 3 trae doble espacio en la fuente oficial).
 */
export const ADJUSTMENT_REASONS = {
  "1": "Devolución parcial de los bienes y/o no aceptación parcial del servicio",
  "2": "Anulación del documento soporte en adquisiciones efectuadas a sujetos no obligados a expedir factura de venta o documento equivalente",
  "3": "Rebaja  o descuento parcial o total",
  "4": "Ajuste de precio",
  "5": "Otros",
} as const;
export type AdjustmentReasonCode = keyof typeof ADJUSTMENT_REASONS;
export const VOID_REASON: AdjustmentReasonCode = "2";

/** NSBF04 (pág. 79): la descripción de la corrección tiene 20 a 5000 caracteres. */
export const ADJUSTMENT_DESCRIPTION_MIN = 20;
export const ADJUSTMENT_DESCRIPTION_MAX = 5000;

/**
 * Tabla 16.2.2 (pág. 220): los ÚNICOS tributos del DS. IVA en cac:TaxTotal;
 * ReteIVA y ReteRenta en cac:WithholdingTaxTotal. No existen ReteICA (07)
 * ni impuesto al consumo (04): un ID fuera de la tabla se rechaza (DSAS16,
 * DSAT12, DSAY12).
 */
export const TAX_SCHEMES = {
  "01": "IVA",
  "05": "ReteIVA",
  "06": "ReteRenta",
} as const;
export type WithholdingSchemeId = "05" | "06";

/** Tabla 16.3.5.1: "94" = unidad. DSBB05 rechaza un unitCode fuera de la tabla. */
export const UNIT_CODE = "94";

/** Tabla 16.2.5.1: responsabilidad "No aplica – Otros". */
export const TAX_LEVEL_NOT_APPLICABLE = "R-99-PN";

/**
 * Tabla 16.2.1 (pág. 220): tipos de identificación. Residente: SIEMPRE "31"
 * (NIT) con DV — DSAJ25a (pág. 147). No residente: cualquiera de la tabla
 * (DSAJ25b). La persona natural residente se identifica con su NIT, que es
 * su número de cédula con el DV calculado.
 */
export const NON_RESIDENT_ID_SCHEMES = {
  "21": "Tarjeta de extranjería",
  "22": "Cédula de extranjería",
  "31": "NIT",
  "41": "Pasaporte",
  "42": "Documento de identificación extranjero",
  "47": "PEP",
  "50": "NIT de otro país",
} as const;
export type NonResidentIdScheme = keyof typeof NON_RESIDENT_ID_SCHEMES;

/** DSAB36 (pág. 28): el sts:QRCode es la URL de consulta del CUDS. */
export function supportDocQrUrl(cuds: string, environment: "1" | "2"): string {
  const host =
    environment === "1"
      ? "https://catalogo-vpfe.dian.gov.co"
      : "https://catalogo-vpfe-hab.dian.gov.co";
  return `${host}/document/searchqr?documentkey=${cuds}`;
}
