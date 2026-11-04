import { db } from "@/lib/db";
import type { KushkiMode } from "@/lib/platformConfig";
import { searchCloudTerminalCharge, type CloudTerminalSearchResult } from "./kushki/cloudTerminal";
import { terminalClaimKey } from "./methods";
import { processKushkiWebhook } from "./webhookHandler";

/**
 * Cuando el cobro síncrono del datáfono no devuelve respuesta (504 del
 * gateway de Kushki a los 60 s, timeout, red, 5xx), el datáfono puede
 * seguir esperando la tarjeta. En vez de dejar el pago incierto de una, se
 * BUSCA el resultado real en Kushki (`transaction_search_online` por el
 * `client_transaction_id` del cobro) hasta que el equipo ya no pueda
 * responder:
 *
 *   - venta APROBADA por el monto de la cuenta → se salda por el mismo camino
 *     que un aprobado del datáfono (`terminal.approved` → totales, rondas
 *     prepagas, factura e impresión automática, igual que en efectivo);
 *   - venta RECHAZADA → se declina y la cuenta queda libre;
 *   - nada todavía → se vuelve a consultar cada 10 s hasta el final de la
 *     ventana; si sigue sin aparecer, el pago queda incierto como hoy
 *     (3 minutos + administrador + evidencia, "Resolver cobro");
 *   - algo raro (reversión, otro monto) → se deja incierto de inmediato: lo
 *     resuelve una persona con el comprobante.
 *
 * Son y Melona, 2026-11-04: dos cobros reales recibieron HTTP 504 con HTML a
 * los ~60 s; el staff esperó 3 minutos, los marcó "no se cobró" y cobró en
 * efectivo sin saber qué había pasado en el equipo.
 */

/**
 * Hasta cuándo, desde el envío, se sigue consultando. El datáfono espera la
 * tarjeta ~90 s (la doc pide timeout ≥ 90 s) y la autorización tarda unos
 * segundos más; el margen cubre que el adquirente registre la venta.
 */
export const TERMINAL_RECOVERY_WINDOW_MS = 135_000;
/** Cada cuánto se vuelve a consultar mientras no aparece nada. */
export const TERMINAL_RECOVERY_INTERVAL_MS = 10_000;

/** Reloj de la recuperación (los tests lo reemplazan para no esperar de verdad). */
export const recoveryClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** Lo accesorio (dejar constancia de la consulta) nunca tumba la recuperación. */
async function quietly(task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (err) {
    console.warn("[terminal-recovery] no se pudo dejar constancia", err);
  }
}

export type TerminalCheckContext = {
  restaurantId: string;
  paymentId: string;
  amountCents: number;
  serialNumber: string;
  clientTransactionId: string;
  businessCode: string | null;
  mode: KushkiMode;
};

export type TerminalCheckResult = {
  /** Lo que dijo la búsqueda. */
  search: CloudTerminalSearchResult["status"];
  /** Si con eso se saldó el pago. */
  settled: "approved" | "declined" | null;
  /** El resultado era definitivo pero no se pudo registrar (queda incierto). */
  settleFailed?: boolean;
  providerRef?: string;
};

/**
 * UNA consulta a Kushki y, si el resultado es definitivo, lo registra.
 * Nunca lanza: un fallo de la consulta es "error" y el pago sigue como estaba.
 */
export async function checkTerminalChargeOnce(ctx: TerminalCheckContext): Promise<TerminalCheckResult> {
  let search: CloudTerminalSearchResult;
  try {
    search = await searchCloudTerminalCharge({
      serialNumber: ctx.serialNumber,
      clientTransactionId: ctx.clientTransactionId,
      amountCents: ctx.amountCents,
      businessCode: ctx.businessCode,
      mode: ctx.mode,
    });
  } catch (err) {
    console.warn("[terminal-recovery] la consulta a Kushki falló", { paymentId: ctx.paymentId, err });
    search = { status: "error" };
  }
  await quietly(() =>
    db.financialOperation.updateMany({
      where: { key: terminalClaimKey(ctx.paymentId) },
      data: {
        checkedAt: new Date(),
        checkStatus: search.status === "unknown" ? `unknown:${search.reason}` : search.status,
      },
    }),
  );

  if (search.status === "approved") {
    // Mismo eventId que el aprobado del cobro síncrono: si los dos llegan,
    // cuenta una sola vez.
    const processed = await processKushkiWebhook({
      eventId: `cloudterm:${ctx.paymentId}:ok`,
      type: "terminal.approved",
      restaurantId: ctx.restaurantId,
      paymentId: ctx.paymentId,
      providerRef: search.transactionReference,
      message: "transaction_search_online",
      raw: search.raw,
    });
    if (processed.status === "error") return { search: search.status, settled: null, settleFailed: true };
    // El código de aprobación queda donde Cobros lo muestra.
    if (search.approvalCode) {
      const approvalCode = search.approvalCode;
      await quietly(() =>
        db.kushkiTransaction.updateMany({
          where: { kushkiTxId: search.transactionReference, paymentId: ctx.paymentId },
          data: { approvalCode },
        }),
      );
    }
    return { search: search.status, settled: "approved", providerRef: search.transactionReference };
  }
  if (search.status === "declined") {
    const processed = await processKushkiWebhook({
      eventId: `cloudterm:${ctx.paymentId}:search-declined:${Date.now()}`,
      type: "terminal.declined",
      restaurantId: ctx.restaurantId,
      paymentId: ctx.paymentId,
      providerRef: search.transactionReference,
      message: "transaction_search_online",
      raw: search.raw,
    });
    if (processed.status === "error") return { search: search.status, settled: null, settleFailed: true };
    return { search: search.status, settled: "declined", providerRef: search.transactionReference };
  }
  return { search: search.status, settled: null };
}

export type TerminalRecoveryOutcome =
  | { status: "approved"; providerRef?: string }
  | { status: "declined" }
  /** Sigue sin saberse: el pago queda incierto. `last` = lo último que dijo Kushki. */
  | { status: "unresolved"; last: CloudTerminalSearchResult["status"] | "settle_failed" };

/**
 * Consulta el resultado hasta que aparezca algo definitivo o se acabe la
 * ventana (`pushedAt` + TERMINAL_RECOVERY_WINDOW_MS). La primera consulta es
 * inmediata.
 */
export async function recoverTerminalOutcome(
  ctx: TerminalCheckContext & { pushedAt: Date },
): Promise<TerminalRecoveryOutcome> {
  const deadline = ctx.pushedAt.getTime() + TERMINAL_RECOVERY_WINDOW_MS;
  for (;;) {
    const check = await checkTerminalChargeOnce(ctx);
    if (check.settled === "approved") return { status: "approved", providerRef: check.providerRef };
    if (check.settled === "declined") return { status: "declined" };
    if (check.settleFailed) return { status: "unresolved", last: "settle_failed" };
    // Una reversión o un monto distinto no se arreglan esperando.
    if (check.search === "unknown") return { status: "unresolved", last: check.search };
    if (recoveryClock.now() + TERMINAL_RECOVERY_INTERVAL_MS > deadline) {
      return { status: "unresolved", last: check.search };
    }
    await recoveryClock.sleep(TERMINAL_RECOVERY_INTERVAL_MS);
    // Si mientras tanto alguien lo resolvió por otro camino, no hay nada
    // más que buscar.
    const current = await db.payment.findUnique({ where: { id: ctx.paymentId }, select: { status: true } });
    if (current?.status !== "pending") return { status: "unresolved", last: check.search };
  }
}
