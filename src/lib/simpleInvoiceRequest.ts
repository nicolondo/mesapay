/**
 * Pedido de la factura GENÉRICA (tirilla a consumidor final) y su correo.
 *
 * Módulo puro —sin DB— para que lo usen por igual el servidor (la ruta
 * `simple-invoice`, `issueInvoiceOnPaid`, las pantallas de "listo") y el
 * formulario del cliente (`SimpleInvoiceSheet`).
 *
 * ── Qué guarda `Order.simpleInvoiceEmail` ──────────────────────────────
 * Tres estados, en la MISMA columna (sin migración):
 *
 *   · `null`      ⇒ nadie pidió la genérica en esta cuenta.
 *   · `""`        ⇒ la pidieron SIN correo: sólo para imprimirla.
 *   · `"a@b.co"`  ⇒ la pidieron con correo: además se envía.
 *
 * El dueño lo pidió textual: "si no se pone ningún correo en lo de la
 * factura electrónica genérica que igual se genere la factura para poderla
 * imprimir". Antes, pedirla en el checkout sin correo daba error, porque la
 * única marca de "la pidieron" era el correo mismo. Hace falta recordar la
 * intención aunque no haya correo: en un comercio SIN facturación
 * electrónica, `issueInvoiceOnPaid` sólo emite (e imprime) lo que alguien
 * pidió. Con facturación electrónica toda venta se factura igual; la marca
 * sirve para que la pantalla de "listo" muestre el estado y el botón de
 * imprimir.
 *
 * El string vacío nunca es un destinatario: todo el que manda correo lo
 * pasa por `simpleInvoiceEmailFrom` (o `resolveDianRecipient`, que también
 * descarta los vacíos).
 */

/** Lo que se guarda cuando se pide la genérica sin correo. */
export const SIMPLE_INVOICE_WITHOUT_EMAIL = "";

/** ¿Alguien pidió la factura genérica en esta cuenta (con o sin correo)? */
export function isSimpleInvoiceRequested(
  stored: string | null | undefined,
): stored is string {
  return typeof stored === "string";
}

/** El correo al que hay que mandarla, o null si la pidieron sin correo. */
export function simpleInvoiceEmailFrom(
  stored: string | null | undefined,
): string | null {
  const email = stored?.trim();
  return email ? email : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type OptionalInvoiceEmailCheck =
  | { ok: true; email: string | null }
  | { ok: false; error: "invalid_email" };

/**
 * Validación del campo de correo de la genérica, en TODOS los puntos de
 * entrada (checkout del comensal, checkout del mesero/operador, pantalla de
 * "listo"): vacío es válido y significa "sin correo, sólo para imprimir";
 * lo escrito tiene que tener forma de correo. El servidor vuelve a validar
 * con zod (`simple-invoice/route.ts`).
 */
export function checkOptionalInvoiceEmail(
  raw: string | null | undefined,
): OptionalInvoiceEmailCheck {
  const email = (raw ?? "").trim();
  if (email === "") return { ok: true, email: null };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "invalid_email" };
  return { ok: true, email };
}
