/**
 * Medio de pago en línea PRESELECCIONADO — lógica pura, sin React ni DB.
 *
 * Quien abre un link de pago (o paga desde el QR) ve una lista de medios.
 * El dueño pidió que Apple Pay quede elegido por defecto cuando el aparato
 * lo admite (Safari en iPhone/Mac con Wallet) y el comercio lo tiene
 * configurado; si no, el orden de siempre: tarjeta y después PSE.
 *
 * `applePayAvailable` lo decide el cliente (ApplePaySession.canMakePayments
 * + el botón del SDK de Kushki renderizado, que exige el dominio validado).
 * Acá sólo se cruza con lo que el comercio habilitó.
 */
export type OnlineMethod = "kushki_apple_pay" | "kushki_card" | "kushki_pse";

/** Orden de preferencia cuando no hay Apple Pay. */
const FALLBACK_ORDER: OnlineMethod[] = ["kushki_card", "kushki_pse"];

export type OnlineMethodChoiceInput = {
  /** El navegador puede pagar con Apple Pay y el botón está listo. */
  applePayAvailable: boolean;
  /** Medios habilitados por el comercio (slugs de PaymentMethodSlug). */
  enabledMethods: readonly string[];
  /** Pagos en línea listos (Kushki activo). Sin esto no hay medio alguno. */
  kushkiReady: boolean;
};

/**
 * Medios en línea en el orden en que se ofrecen: el primero es el
 * preseleccionado; el resto, alternativas. Vacío si no se puede cobrar en
 * línea.
 */
export function onlineMethodsInOrder(input: OnlineMethodChoiceInput): OnlineMethod[] {
  if (!input.kushkiReady) return [];
  const enabled = new Set(input.enabledMethods);
  const out: OnlineMethod[] = [];
  if (input.applePayAvailable && enabled.has("kushki_apple_pay")) out.push("kushki_apple_pay");
  for (const method of FALLBACK_ORDER) if (enabled.has(method)) out.push(method);
  return out;
}

/** El medio preseleccionado, o null si no hay ninguno en línea. */
export function defaultOnlineMethod(input: OnlineMethodChoiceInput): OnlineMethod | null {
  return onlineMethodsInOrder(input)[0] ?? null;
}
