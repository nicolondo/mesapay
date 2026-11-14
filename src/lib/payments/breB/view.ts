/**
 * Lo que las pantallas ven de un cobro Bre-B. Sin dependencias de servidor:
 * lo importan componentes de cliente. Quien lo arma es `service.ts`.
 */

/**
 *   creating  — reservado, todavía sin QR (transitorio).
 *   active    — QR vigente, esperando la transferencia.
 *   approved  — pagado.
 *   declined  — rechazado (o el QR no se pudo generar).
 *   expired   — venció sin pago.
 *   canceled  — cancelado; el QR ya no sirve.
 *   uncertain — no se pudo confirmar el resultado: NO cobrar por otro medio
 *               hasta consultarlo o resolverlo en Cobros.
 */
export type BreBChargeState =
  | "creating"
  | "active"
  | "approved"
  | "declined"
  | "expired"
  | "canceled"
  | "uncertain";

export const BRE_B_CHARGE_STATES: readonly BreBChargeState[] = [
  "creating",
  "active",
  "approved",
  "declined",
  "expired",
  "canceled",
  "uncertain",
];

/** Estados en los que el cobro sigue reservando su parte de la cuenta. */
export const BRE_B_OPEN_STATES: readonly BreBChargeState[] = ["creating", "active", "uncertain"];

export function isBreBOpenState(state: string | null | undefined): boolean {
  return (BRE_B_OPEN_STATES as readonly string[]).includes(state ?? "");
}

export function asBreBState(value: string | null | undefined): BreBChargeState {
  return (BRE_B_CHARGE_STATES as readonly string[]).includes(value ?? "") ? (value as BreBChargeState) : "uncertain";
}

export type BreBChargeView = {
  chargeId: string;
  /** Pago de la cuenta (null en un link de pago de monto fijo). */
  paymentId: string | null;
  state: BreBChargeState;
  /** TOTAL a transferir (comida + propina). */
  amountCents: number;
  currency: string;
  /**
   * Imagen del QR lista para `<img>`: SIEMPRE `data:image/png;base64,…`
   * (lo valida el servidor). Sólo viene cuando se pide con QR.
   */
  qrImage?: string | null;
  /** Cuándo vence (ISO). null = todavía no hay QR. */
  expiresAt: string | null;
  /** Hora del servidor (ISO): la cuenta regresiva no depende del reloj del teléfono. */
  serverNow: string;
  /** Cuentas: con este pago la cuenta quedó pagada del todo. */
  orderPaid: boolean;
  /** Código corto de por qué quedó incierto / rechazado. */
  reason: string | null;
  /** Sólo en modo demo: página que simula la app del banco. */
  mockUrl: string | null;
};

/** Lo mínimo de un Bre-B en curso para los avisos de pagos pendientes del staff. */
export type BreBPendingView = {
  state: BreBChargeState;
  expiresAt: string | null;
};

/** Segundos que le quedan al QR según la hora del servidor (nunca negativo). */
export function breBSecondsLeft(expiresAt: string | null, nowMs: number): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** "4:07" para la cuenta regresiva. */
export function formatBreBCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}
