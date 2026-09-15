/**
 * Reglas de REINTENTO de la emisión automática a la DIAN.
 *
 * Todo lo que decide "qué documento se vuelve a intentar y cuándo" vive
 * acá, separado de la DB y del route handler, para poder testearlo sin
 * base de datos — el mismo criterio que `print/claim.ts` en la cola de
 * impresión. Es puro a propósito.
 */

/** Estados desde los que se puede (re)emitir. `rejected` sólo a mano. */
export const RETRYABLE_STATES = ["to_send", "error", "rejected"] as const;

/**
 * Estados que el BARRIDO reintenta solo. `rejected` NO está: la DIAN ya
 * evaluó ese XML y lo rechazó; mandarlo igual otra vez es el mismo rechazo
 * y cada rechazo quema un consecutivo. Se corrige y se reintenta a mano.
 */
export const SWEEP_STATES = ["to_send", "error"] as const;

/**
 * Tope de envíos automáticos de un mismo documento. Sin esto, un XML que
 * la DIAN no logra procesar (o un canal caído por días) se reintentaría
 * para siempre. Pasado el tope queda en `error`, visible, y se reintenta
 * a mano.
 */
export const MAX_ATTEMPTS = 8;

/**
 * Espera tras un ERROR de canal (timeout, caída de la DIAN): 2 min × 2^n,
 * con tope de 6 h. Con MAX_ATTEMPTS = 8 los reintentos se reparten en
 * ~8 horas: 2, 4, 8, 16, 32, 64, 128, 256 min. Suficiente para que una
 * caída de la DIAN de una tarde entera no agote los intentos.
 */
export function emissionBackoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(6 * 60 * 60_000, 2 * 60_000 * 2 ** (n - 1));
}

/**
 * Espera tras un BLOQUEO de configuración (falta la resolución, el
 * municipio, el correo del emisor, el certificado…). No cuenta como
 * intento —no se mandó nada— y no crece: no hay nada que "reintentar",
 * hay que esperar a que el operador complete la config. 10 minutos es lo
 * que tarda, como mucho, en fluir todo después de arreglarla; el botón
 * "Reintentar emisión" de la pantalla no espera.
 */
export const BLOCKED_RETRY_MS = 10 * 60_000;

/**
 * Un documento en `sent` es un reclamo en curso. Si no vuelve en este
 * tiempo, el proceso que lo reclamó murió a mitad (deploy, caída) y se
 * puede volver a reclamar. Generoso: la DIAN tarda segundos; 15 minutos
 * es un proceso muerto, no uno lento.
 */
export const STALE_CLAIM_MS = 15 * 60_000;

/** Cuántos documentos toma un barrido como mucho. */
export const DEFAULT_SWEEP_LIMIT = 50;

/**
 * Filtro que va a la DB para el barrido. Deja pasar:
 *   - lo que espera (`to_send`) cuyo backoff/espera ya venció,
 *   - lo que falló por canal (`error`) sin pasarse del tope, ídem, y
 *   - lo reclamado (`sent`) que nunca volvió,
 * siempre documentos de una orden real (los del set de pruebas no tienen
 * ni tirilla ni orden y no se tocan).
 */
export function claimableDianWhere(now: Date) {
  const due = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };
  return {
    kind: "invoice",
    AND: [
      { OR: [{ simpleInvoiceId: { not: null } }, { orderId: { not: null } }] },
      {
        OR: [
          { state: "to_send", ...due },
          { state: "error", attempts: { lt: MAX_ATTEMPTS }, ...due },
          { state: "sent", updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
        ],
      },
    ],
  };
}

/**
 * Condición del RECLAMO: pasar a `sent` sólo desde un estado reintentable
 * o desde un `sent` vencido. Es el `where` del updateMany que hace de
 * cerrojo — si dos emisores lo intentan a la vez, uno actualiza cero filas.
 */
export function claimWhere(documentId: string, now: Date) {
  return {
    id: documentId,
    OR: [
      { state: { in: [...RETRYABLE_STATES] } },
      { state: "sent", updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    ],
  };
}
