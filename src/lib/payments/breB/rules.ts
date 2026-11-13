import type { BreBStatusResult } from "../kushki/breB";

/**
 * Reglas puras de Bre-B: qué se le exige a una aprobación antes de saldar y
 * los tiempos del cobro. Sin I/O, para probarlas solas.
 */

export type BreBExpected = {
  amountCents: number;
  currency: string;
  token: string | null;
  transactionReference: string | null;
  ticketNumber: string | null;
};

export type BreBReviewCode =
  | "reference_mismatch"
  | "amount_unverified"
  | "amount_mismatch"
  | "currency_mismatch";

export type BreBApprovalCheck = { ok: true } | { ok: false; code: BreBReviewCode };

/**
 * Antes de saldar una aprobación: la referencia, el monto y la moneda
 * tienen que ser los del cobro. Falla cerrado: una aprobación SIN monto no
 * se puede verificar, así que no se aplica sola (va a conciliación).
 */
export function verifyBreBApproval(
  expected: BreBExpected,
  outcome: Pick<BreBStatusResult, "amountCents" | "currency" | "token" | "transactionReference" | "ticketNumber">,
): BreBApprovalCheck {
  if (outcome.token && expected.token && outcome.token !== expected.token) {
    return { ok: false, code: "reference_mismatch" };
  }
  if (
    outcome.transactionReference &&
    expected.transactionReference &&
    outcome.transactionReference !== expected.transactionReference
  ) {
    return { ok: false, code: "reference_mismatch" };
  }
  if (outcome.ticketNumber && expected.ticketNumber && outcome.ticketNumber !== expected.ticketNumber) {
    return { ok: false, code: "reference_mismatch" };
  }
  if (outcome.amountCents == null) return { ok: false, code: "amount_unverified" };
  if (outcome.amountCents !== expected.amountCents) return { ok: false, code: "amount_mismatch" };
  if (outcome.currency && outcome.currency !== expected.currency) return { ok: false, code: "currency_mismatch" };
  return { ok: true };
}

/** Margen después del vencimiento antes de darlo por vencido (relojes, red). */
export const BRE_B_EXPIRY_GRACE_MS = 8_000;
/** Cada cuánto, como mucho, se le pregunta el estado a Kushki por un cobro. */
export const BRE_B_STATUS_THROTTLE_MS = 10_000;
/** Un cobro que se quedó en `creating` más de esto es un proceso que murió. */
export const BRE_B_CREATING_STALE_MS = 120_000;

export function breBExpired(expiresAt: Date | null, now: Date): boolean {
  return !!expiresAt && now.getTime() >= expiresAt.getTime() + BRE_B_EXPIRY_GRACE_MS;
}
