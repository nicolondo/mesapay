// Formato del consecutivo de gastos («G-0012») — puro, sin base de datos:
// lo usan la pantalla (cliente), los reportes y el servidor. La asignación
// (transacción, candado, versión vieja) vive en expenseNumber.ts.

export const EXPENSE_NUMBER_PREFIX = "G-";

/** 12 → «G-0012» (crece sin cortar: «G-12345»). null si no tiene número. */
export function formatExpenseNumber(n: number | null | undefined): string | null {
  if (n == null || !Number.isInteger(n) || n < 1) return null;
  return `${EXPENSE_NUMBER_PREFIX}${String(n).padStart(4, "0")}`;
}

/** Mayor entero que cabe en la columna (INTEGER de Postgres). */
const INT4_MAX = 2_147_483_647;

/**
 * Lo escrito en el buscador → consecutivo, si lo parece: «G-0012», «g12»,
 * «G 12», «#12». Sólo dígitos NO cuenta como consecutivo seguro (puede ser
 * un NIT o una factura del proveedor): eso lo decide quien busca.
 */
export function parseExpenseNumber(text: string): number | null {
  const m = /^\s*(?:g\s*-?\s*|#\s*)0*(\d{1,10})\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 && n <= INT4_MAX ? n : null;
}

/** Sólo dígitos («12», «0012») → el número, o null. */
export function digitsAsNumber(text: string): number | null {
  const m = /^\s*0*(\d{1,10})\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 1 && n <= INT4_MAX ? n : null;
}

/**
 * Cómo citan los reportes a un gasto (auxiliares de impuestos, cartera):
 * el consecutivo y, si hay, el número del documento del proveedor —
 * «G-0012 · FE-1280»—. Sin consecutivo todavía, el documento o `fallback`.
 */
export function expenseDocumentLabel(
  e: { number?: number | null; documentNumber?: string | null },
  fallback: string,
): string {
  const parts = [formatExpenseNumber(e.number), e.documentNumber?.trim() || null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : fallback;
}
