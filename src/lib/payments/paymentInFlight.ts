import type { PaymentMethod } from "@prisma/client";

/**
 * El error accionable de un cobro del staff bloqueado por un pago en vuelo
 * (ver `staffCharge.ts`). Vive aparte y sin dependencias de servidor para
 * que `secureApi` pueda reconocerlo sin cargar la lógica de cobro.
 */

/** Código del 409 cuando un pago en vuelo no deja cobrar. El front lo traduce. */
export const PENDING_PAYMENT_IN_FLIGHT = "pending_payment_in_flight";

/** Lo que la pantalla necesita para decir qué pago está pendiente. */
export type PaymentInFlight = {
  paymentId: string;
  method: PaymentMethod;
  /** TOTAL del pago (comida + propina), como en `Payment.amountCents`. */
  amountCents: number;
  tipCents: number;
  createdAt: string;
};

/**
 * Se lanza DENTRO de la transacción (la revierte entera) y `secureApi` lo
 * convierte en `409 { error: "pending_payment_in_flight", pending }`.
 */
export class PendingPaymentInFlightError extends Error {
  readonly pending: PaymentInFlight;
  constructor(pending: PaymentInFlight) {
    super(PENDING_PAYMENT_IN_FLIGHT);
    this.name = "PendingPaymentInFlightError";
    this.pending = pending;
  }
}
