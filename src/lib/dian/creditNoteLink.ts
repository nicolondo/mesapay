// Enlace a Notas crédito con una factura ya elegida: "Anular con nota
// crédito" desde la lista de facturas electrónicas y desde el aviso de
// clientes que pidieron factura después de emitida. El parámetro y su
// lectura viven juntos para que el enlace y la pantalla no diverjan.

export const CREDIT_NOTES_PATH = "/operator/facturas/notas-credito";
export const CREDIT_NOTE_PRESELECT_PARAM = "factura";

/** /operator/facturas/notas-credito?factura=<SimpleInvoice.id> */
export function creditNotePreselectHref(simpleInvoiceId: string): string {
  return `${CREDIT_NOTES_PATH}?${CREDIT_NOTE_PRESELECT_PARAM}=${encodeURIComponent(simpleInvoiceId)}`;
}

/**
 * La factura a preseleccionar, si la URL trae una con forma de id. Es sólo
 * una sugerencia: la pantalla la carga por la misma ruta que el botón
 * "Elegir" (`credit-notes/source/[id]`), que valida comercio y estado.
 */
export function preselectedInvoiceId(
  searchParams: Record<string, string | string[] | undefined>,
): string | null {
  const raw = searchParams[CREDIT_NOTE_PRESELECT_PARAM];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}
