import { db } from "@/lib/db";
import type { KushkiChargeDeclined } from "./kushki/chargeError";
import { processKushkiWebhook, type WebhookProcessResult } from "./webhookHandler";

/**
 * Liquida como RECHAZADO un cobro que Kushki rechazó con un 4xx definitivo
 * (el proveedor LANZÓ en vez de devolver `declined`; ver
 * `classifyKushkiChargeError`). Es exactamente el camino de un
 * `charge.declined` normal: `processKushkiWebhook` declina el pago bajo
 * `lockOrder`, saca la cuenta de «pagando» si no le queda otro pago vivo y
 * avisa a las pantallas (`order.updated` + `payment.declined`), de forma
 * idempotente por `eventId`.
 *
 * Además guarda el motivo: el evento (`KushkiWebhookEvent.payload`) y un
 * espejo `KushkiTransaction` declinado con el código y el mensaje de Kushki.
 * Como el rechazo no trae referencia de transacción, el espejo usa la llave
 * propia `rejected:<paymentId>`; el pago queda SIN `providerRef`, para que
 * una notificación posterior de Kushki con su referencia real no choque.
 *
 * Si la liquidación falla devuelve `status: "error"` y quien llama deja el
 * pago incierto, igual que con un rechazo normal.
 */
export async function settleRejectedCharge(args: {
  restaurantId: string;
  paymentId: string;
  amountCents: number;
  currency: string;
  failure: KushkiChargeDeclined;
  /** Prefijo del `eventId` idempotente (p. ej. "charge", "pickup", "pse"). */
  source: string;
  kind?: "charge.declined" | "pse.declined";
}): Promise<WebhookProcessResult> {
  const { failure } = args;
  const message = [failure.code, failure.message].filter(Boolean).join(" · ") || `HTTP ${failure.httpStatus}`;
  // Sólo lo necesario para auditar: nunca el cuerpo crudo de Kushki.
  const raw = {
    rejectedByProvider: true,
    httpStatus: failure.httpStatus,
    code: failure.code,
    message: failure.message,
    reason: failure.reason,
  };
  try {
    await db.kushkiTransaction.upsert({
      where: { kushkiTxId: `rejected:${args.paymentId}` },
      update: {},
      create: {
        restaurantId: args.restaurantId,
        paymentId: args.paymentId,
        kushkiTxId: `rejected:${args.paymentId}`,
        kind: "charge",
        status: "declined",
        amountCents: args.amountCents,
        currency: args.currency,
        raw,
        message,
      },
    });
  } catch {
    // El espejo es sólo auditoría: que falle no puede dejar la mesa bloqueada.
    console.error("rejected_charge_mirror_failed", { paymentId: args.paymentId });
  }
  return processKushkiWebhook({
    eventId: `${args.source}:${args.paymentId}:declined`,
    type: args.kind ?? "charge.declined",
    paymentId: args.paymentId,
    restaurantId: args.restaurantId,
    amountCents: args.amountCents,
    message,
    raw,
  });
}
