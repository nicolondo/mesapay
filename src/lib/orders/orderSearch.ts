/**
 * Búsqueda de la lista de Órdenes por número de documento: la factura
 * («FESM7913», «fesm 7913», «7913») o la nota crédito («NC12»), que lleva a
 * la orden de su factura original. Lógica pura; la consulta vive en
 * `orderSearchQuery.ts`.
 *
 * Reglas:
 *  · Mayúsculas/minúsculas, espacios, guiones, puntos y «#» no cuentan, y
 *    los ceros a la izquierda del número tampoco («FESM-06482» = el formato
 *    viejo de la tirilla, hoy «FESM6482»).
 *  · Con prefijo, el prefijo tiene que ser EL de la factura: el que quedó
 *    congelado en su tirilla al emitirla (`snapshot.invoicePrefix`, ver
 *    `formatInvoiceNumber`), no el de la resolución de hoy. Así «POS42» no
 *    trae la FESM42 de la resolución nueva.
 *  · El número solo («7913») trae la factura con ese consecutivo, con el
 *    prefijo que tenga. La misma búsqueda sigue encontrando por código de
 *    cuenta (`shortCode` que contenga «7913»).
 *  · Las notas crédito se buscan sólo con su prefijo («NC12»): el número
 *    solo de una nota se confundiría con el de una factura.
 */

const MAX_INT4 = 2_147_483_647;

/**
 * Forma canónica de un número de documento: sin separadores, en
 * mayúsculas y sin ceros a la izquierda en el consecutivo final.
 */
export function canonicalDocumentNumber(raw: string): string {
  const compact = raw.toUpperCase().replace(/[\s\-_.#/]/g, "");
  const m = /^(.*?)(\d+)$/.exec(compact);
  if (!m) return compact;
  const digits = m[2].replace(/^0+(?=\d)/, "");
  return `${m[1]}${digits}`;
}

export type DocumentSearch = {
  /** Forma canónica de lo buscado. */
  canonical: string;
  /** Sólo dígitos: el consecutivo de la factura, con cualquier prefijo. */
  numericOnly: boolean;
  /**
   * Consecutivos posibles de la factura (para la consulta): con «FE17913»
   * el prefijo puede ser «FE» (17913) o «FE1» (7913); se descarta después
   * con el prefijo real de cada factura (`invoiceMatchesSearch`).
   */
  invoiceNumbers: number[];
  /** Número de nota crédito a buscar tal cual (con prefijo), o null. */
  creditNoteNumber: string | null;
};

/**
 * Lo que la búsqueda podría ser como número de documento, o null si no
 * puede serlo (sin dígitos al final, o demasiado larga).
 */
export function parseDocumentSearch(q: string): DocumentSearch | null {
  const canonical = canonicalDocumentNumber(q.trim());
  if (!canonical || canonical.length > 30) return null;
  const m = /^([A-Z0-9]*?)(\d+)$/.exec(canonical);
  if (!m) return null;
  const digits = m[2];
  const numericOnly = m[1] === "";
  const numbers = new Set<number>();
  // Todos los sufijos del número final: el prefijo de una resolución puede
  // terminar en dígito. El número solo es exactamente ese consecutivo.
  const suffixes = numericOnly ? [digits] : digits.split("").map((_, i) => digits.slice(i));
  for (const s of suffixes) {
    const n = Number(s);
    if (Number.isSafeInteger(n) && n > 0 && n <= MAX_INT4) numbers.add(n);
  }
  if (numbers.size === 0) return null;
  return {
    canonical,
    numericOnly,
    invoiceNumbers: [...numbers],
    creditNoteNumber: numericOnly ? null : canonical,
  };
}

/**
 * ¿Esta factura (prefijo congelado + consecutivo) es la buscada? El
 * número solo coincide con el consecutivo; con prefijo, el número completo
 * tal como se imprime.
 */
export function invoiceMatchesSearch(
  search: DocumentSearch,
  invoice: { prefix: string | null; invoiceNumber: number },
): boolean {
  if (search.numericOnly) return String(invoice.invoiceNumber) === search.canonical;
  return canonicalDocumentNumber(`${invoice.prefix ?? ""}${invoice.invoiceNumber}`) === search.canonical;
}

/** ¿Esta nota crédito es la buscada? */
export function creditNoteMatchesSearch(search: DocumentSearch, documentNumber: string): boolean {
  return search.creditNoteNumber != null && canonicalDocumentNumber(documentNumber) === search.creditNoteNumber;
}
