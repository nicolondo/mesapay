/**
 * Códigos de rechazo de Kushki (tarjeta) → motivo traducible por la UI.
 * Las rutas devuelven el motivo como código, nunca un texto en un idioma
 * fijo; la pantalla lo traduce con el namespace `chargeDecline`
 * (`useChargeDeclineText`).
 *
 * Quién decide si un error de Kushki ES un rechazo (y no un resultado
 * incierto) es `classifyKushkiChargeError` (./chargeError.ts); esta tabla
 * sólo le pone el motivo.
 */
export type KushkiDeclineReason =
  | "security_rejected"
  | "card_cvv"
  | "card_funds"
  | "card_invalid"
  | "card_blocked"
  | "merchant_config"
  | "charge_failed";

/**
 * `code` de Kushki (ya normalizado: sin espacios, en mayúsculas) → motivo.
 * Tabla de PAGOS ÚNICOS con tarjeta (`/card/v1/charges`): un mismo K-código
 * significa otra cosa en cargos recurrentes (ver
 * `lib/billing/subscriptionErrors.ts`).
 *
 * No está el 577 (token ya usado / vencido): NO es un rechazo definitivo
 * (un intento previo con ese token pudo haber cobrado), y `chargeError.ts`
 * lo deja incierto.
 */
const REASON_BY_CODE: Record<string, KushkiDeclineReason> = {
  // K322 «Transacción rechazada»: una regla de seguridad (antifraude) de
  // Kushki bloqueó el cargo. Es el mismo código que ya vimos en el débito
  // automático (`security_rejected` en subscriptionErrors.ts).
  K322: "security_rejected",
  "022": "card_cvv",
  "021": "card_funds",
  "017": "card_invalid",
  "023": "card_blocked",
  K040: "merchant_config",
};

/** Códigos con motivo propio: rechazos definitivos conocidos. */
export const KNOWN_DECLINE_CODES: ReadonlySet<string> = new Set(Object.keys(REASON_BY_CODE));

/** Motivo de un `code` de Kushki ya normalizado. Lo no mapeado es genérico. */
export function declineReasonForCode(code: string | null | undefined): KushkiDeclineReason {
  return (code ? REASON_BY_CODE[code] : undefined) ?? "charge_failed";
}
