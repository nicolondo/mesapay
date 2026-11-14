// Número de un documento de proveedor (factura de compra, soporte de un
// gasto) y la referencia al documento ya registrado que choca con él.
// PURO —sin DB ni red—: lo usan el servidor (duplicateDocuments.ts), el
// buscador de Compras y el aviso de la UI.

/**
 * Palabras con las que a veces se escribe el número y que no son parte de
 * él: «Factura», «Fact.», «N°», «Nº», «No.», «Nro», «Núm.», «Número», «#».
 * Sólo al principio y sólo las formas explícitas: «N123» o «NO123» se
 * quedan como están, porque «N»/«NO» podría ser el prefijo de la factura.
 */
const LEADING_LABELS =
  /^(?:(?:factura|fact\.?)(?:\s+(?:de\s+)?(?:venta|compra|electronica))*\s*)?(?:n\s*[°º]|no\.|nro\.?|num\.|numero|#)?\s*:?\s*/i;

/**
 * Clave para comparar números de factura: sin mayúsculas ni tildes, sin
 * espacios, guiones, puntos ni barras, y sin ceros a la izquierda en cada
 * tramo de dígitos. Así «FE-000123», «fe 123», «FE0123» y «Factura N° FE 123»
 * son el mismo documento («FE123»), y «000123» = «123».
 *
 * null = no hay número (vacío o sólo separadores).
 */
export function normalizeDocumentNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const folded = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(LEADING_LABELS, "")
    .toUpperCase()
    // Ceros a la izquierda de cada tramo de dígitos («FE-0007» → «FE-7»;
    // un tramo todo en ceros queda «0»).
    .replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ""));
  const key = folded.replace(/[^A-Z0-9]/g, "");
  return key === "" ? null : key;
}

/** Tipo del documento ya registrado. */
export type SupplierDocumentKind = "purchase" | "expense";

/**
 * El documento que ya existe y con el que choca el que se intenta guardar:
 * lo justo para decirle al operador CUÁL es y dejarlo abrirlo.
 */
export type ExistingSupplierDocument = {
  kind: SupplierDocumentKind;
  id: string;
  /** Número de factura tal como se escribió (null si no tiene). */
  number: string | null;
  /** Consecutivo de la compra (OC-0007); null en gastos. */
  purchaseNumber: number | null;
  /** Consecutivo interno del gasto (G-0012); null/ausente en compras. */
  expenseNumber?: number | null;
  /** Fecha del documento (compra: cuándo se registró; gasto: su fecha contable), ISO. */
  date: string;
  /** Total a pagar, en centavos. */
  totalCents: number;
  supplierName: string | null;
  /** Dónde abrirlo en el panel. */
  href: string;
};

/**
 * `duplicate_document`: misma factura (proveedor + número) — se bloquea.
 * `possible_duplicate`: sin número, mismo proveedor, día y total — se
 * advierte y se puede guardar igual con confirmación explícita.
 */
export type DuplicateConflictCode = "duplicate_document" | "possible_duplicate";

export type DuplicateConflict = {
  code: DuplicateConflictCode;
  existing: ExistingSupplierDocument;
};

/**
 * Lee el conflicto de una respuesta 409 de las rutas de alta
 * (`{ error, duplicate }`). null si la respuesta es otra cosa.
 */
export function parseDuplicateConflict(body: unknown): DuplicateConflict | null {
  if (!body || typeof body !== "object") return null;
  const { error, duplicate } = body as { error?: unknown; duplicate?: unknown };
  if (error !== "duplicate_document" && error !== "possible_duplicate") return null;
  if (!duplicate || typeof duplicate !== "object") return null;
  const d = duplicate as Partial<ExistingSupplierDocument>;
  if ((d.kind !== "purchase" && d.kind !== "expense") || typeof d.id !== "string" || typeof d.href !== "string") {
    return null;
  }
  return {
    code: error,
    existing: {
      kind: d.kind,
      id: d.id,
      number: typeof d.number === "string" ? d.number : null,
      purchaseNumber: typeof d.purchaseNumber === "number" ? d.purchaseNumber : null,
      // Consecutivo del gasto (G-0012): sólo si viene (las compras no lo traen).
      ...(typeof d.expenseNumber === "number" ? { expenseNumber: d.expenseNumber } : {}),
      date: typeof d.date === "string" ? d.date : "",
      totalCents: typeof d.totalCents === "number" ? d.totalCents : 0,
      supplierName: typeof d.supplierName === "string" ? d.supplierName : null,
      href: d.href,
    },
  };
}

/**
 * Cómo pide el cliente la advertencia suave (sin número):
 *  · "check": revísala y, si hay un documento parecido, responde 409
 *    `possible_duplicate` sin guardar.
 *  · "allow": el operador ya vio la advertencia y decidió guardar.
 *  · ausente: no se revisa (clientes que aún no muestran la advertencia).
 * La factura repetida CON número se bloquea siempre, pida lo que pida.
 */
export const POSSIBLE_DUPLICATE_MODES = ["check", "allow"] as const;
export type PossibleDuplicateMode = (typeof POSSIBLE_DUPLICATE_MODES)[number];
