// "N facturas esperando emisión — falta X": lo que la pantalla de
// facturas y la tarjeta de Facturación DIAN muestran cuando la emisión
// automática está frenada.
//
// Antes no importaba: con emisión manual, una configuración incompleta
// sólo se notaba al apretar "Emitir". Con emisión automática, una config
// incompleta frena TODA la facturación del comercio en silencio — los
// documentos se acumulan en `to_send` y nadie apretó nada. Esto lo hace
// visible. Lo mismo con el rango de la resolución: aviso amarillo desde
// que quedan menos de NUMBERS_LEFT_WARNING números, rojo cuando se agotó.
import { db } from "@/lib/db";
import { resolveEmisor } from "@/lib/dian/config";
import { isRestaurantWideReason, type PendingBlockReason } from "@/lib/dian/emitInvoice";
import { SWEEP_STATES } from "@/lib/dian/retry";

/** Desde cuántos números restantes se avisa que pidan resolución nueva. */
export const NUMBERS_LEFT_WARNING = 500;

export type PendingEmissionSummary = {
  /** Documentos de venta esperando emisión (to_send/error), en total. */
  waiting: number;
  /**
   * De esos, los frenados por algo del COMERCIO (configuración o rango
   * agotado) y el motivo dominante. null ⇒ nada frena al comercio: lo que
   * espera son reintentos de canal o casos puntuales.
   */
  blockedBy: PendingBlockReason | null;
  blockedCount: number;
  /**
   * Números que quedan en la resolución, contando el próximo a emitir.
   * null ⇒ no hay resolución cargada (o no hay tope).
   */
  numbersLeft: number | null;
};

export type PendingRow = { lastError: string | null; count: number };

/**
 * Resumen puro a partir de las filas agrupadas por `lastError`. Separado
 * de la DB para poder testearlo.
 */
export function summarizePendingEmission(
  rows: PendingRow[],
  emisor: { resolutionTo: number | null; invoiceNextNumber: number } | null,
): PendingEmissionSummary {
  let waiting = 0;
  let blockedCount = 0;
  let blockedBy: PendingBlockReason | null = null;
  let top = 0;
  for (const row of rows) {
    waiting += row.count;
    if (row.lastError && isRestaurantWideReason(row.lastError)) {
      blockedCount += row.count;
      if (row.count > top) {
        top = row.count;
        blockedBy = row.lastError as PendingBlockReason;
      }
    }
  }
  const numbersLeft =
    emisor && emisor.resolutionTo != null
      ? Math.max(0, emisor.resolutionTo - emisor.invoiceNextNumber + 1)
      : null;
  return { waiting, blockedBy, blockedCount, numbersLeft };
}

/**
 * `lastError` sólo cuenta como bloqueo del comercio si es uno de los
 * motivos conocidos de configuración/rango. Un error de canal ("timeout",
 * una regla FAJ71 de la DIAN) es texto libre y no frena al comercio.
 */
const KNOWN_REASONS = new Set<string>([
  "no_config",
  "no_certificate",
  "missing_credentials",
  "master_key_missing",
  "decrypt_failed",
  "no_emisor",
  "resolution_incomplete",
  "location_incomplete",
  "contact_email_incomplete",
  "numbering_exhausted",
]);

export async function pendingEmissionSummary(
  restaurantId: string,
): Promise<PendingEmissionSummary> {
  const [groups, emisor] = await Promise.all([
    db.dianDocument.groupBy({
      by: ["lastError"],
      where: {
        restaurantId,
        kind: "invoice",
        state: { in: [...SWEEP_STATES] },
        // Documentos de venta: con tirilla o con orden (los del set de
        // pruebas no tienen ninguna de las dos).
        OR: [{ simpleInvoiceId: { not: null } }, { orderId: { not: null } }],
      },
      _count: { _all: true },
    }),
    resolveEmisor(restaurantId),
  ]);
  const rows: PendingRow[] = groups.map((g) => ({
    lastError: g.lastError && KNOWN_REASONS.has(g.lastError) ? g.lastError : null,
    count: g._count._all,
  }));
  return summarizePendingEmission(rows, emisor);
}
