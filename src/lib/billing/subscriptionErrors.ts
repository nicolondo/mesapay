import { KushkiHttpError, KushkiSchemaError } from "@/lib/payments/kushki/client";

/**
 * Por qué falló una operación del débito automático (activar / cambiar
 * tarjeta), en un set cerrado que la UI traduce. Las rutas devuelven el
 * motivo, nunca un texto en un idioma fijo ni el body crudo de Kushki.
 */
export type SubscriptionErrorReason =
  | "security_rejected" // una regla de seguridad (antifraude) de Kushki bloqueó la tarjeta
  | "card_declined" // el banco emisor o el procesador rechazó
  | "card_invalid" // datos de tarjeta malos, vencida o no válida para este medio
  | "not_found" // Kushki no conoce ese id de suscripción con estas credenciales (K012 / 404)
  | "not_configured" // NUESTRO lado: credenciales, comercio no habilitado, request mal armado
  | "unavailable" // timeout, 5xx, red caída
  | "unknown";

export type SubscriptionErrorInfo = {
  reason: SubscriptionErrorReason;
  /** `code` de Kushki (p. ej. "K322") para que el comercio lo cite a soporte. */
  providerCode: string | null;
};

// OJO: un mismo K-código significa cosas distintas según el producto de
// Kushki (K049 = tarjeta vencida en suscripciones, token usado en pagos
// únicos). Usamos la tabla de CARGOS RECURRENTES, que es la de
// /subscriptions/v1/card, salvo K322 (ver abajo). Lo no mapeado → "unknown".
const REASON_BY_CODE: Record<string, SubscriptionErrorReason> = {
  // K322 no está en la tabla de recurrentes pero Kushki lo devolvió en
  // producción desde /subscriptions/v1/card; significado de
  // https://docs.kushki.com/co/card-payments/one-step-payments/error-codes
  K322: "security_rejected",

  // `code` — https://docs.kushki.com/co/recurring-payments/error-codes
  K021: "security_rejected", // rechazo por SiftScience (antifraude)
  K006: "card_declined", // rechazo por cobro de validación
  K007: "card_declined", // bloqueada por el emisor
  K028: "card_declined", // processor declined
  K015: "card_invalid", // no permitida sin CVV2
  K025: "card_invalid", // tarjeta inválida
  K029: "card_invalid", // datos de tarjeta no coinciden
  K044: "card_invalid", // el BIN no soporta este medio
  K049: "card_invalid", // tarjeta expirada
  K012: "not_found", // id de suscripción no válida: Kushki no la conoce con estas credenciales
  K001: "not_configured", // body inválido (bug nuestro)
  K004: "not_configured", // id de comercio no válido
  K010: "not_configured", // comercio no habilitado para suscripciones
  K011: "not_configured", // startDate inválida (bug nuestro)
  K026: "not_configured", // comercio deshabilitado
  K034: "not_configured", // no existen procesadores
  K040: "not_configured", // id de comercio no corresponde a la credencial
  K003: "unavailable", // error en la respuesta del gateway
  K027: "unavailable", // no se pudo completar / timeout
  K035: "unavailable", // procesador no disponible
  K046: "unavailable", // timeout

  // `processorError` — https://docs.kushki.com/co/recurring-payments/error-codes
  "501": "card_declined", // contactar al emisor
  "504": "card_declined", // tarjeta reportada
  "505": "card_declined", // declinada por procesador o emisor
  "512": "card_declined", // no permitida por el emisor
  "515": "card_declined", // el emisor no puede autorizar
  "541": "card_declined", // reportada como perdida
  "543": "card_declined", // reportada como robada
  "551": "card_declined", // fondos insuficientes
  "557": "card_declined", // el emisor no puede autorizar
  "559": "card_declined", // sospecha de fraude
  "561": "card_declined", // límite diario excedido
  "562": "card_declined", // restringida por el emisor
  "563": "card_declined", // violación de seguridad (emisor)
  "565": "card_declined", // reglas de seguridad
  "514": "card_invalid", // número de tarjeta no válido
  "518": "card_invalid", // tarjeta vencida
  "520": "card_invalid", // nombre del titular incorrecto
  "521": "card_invalid", // apellido del titular incorrecto
  "553": "card_invalid", // tarjeta no compatible
  "579": "card_invalid", // fecha de vencimiento incorrecta
  "582": "card_invalid", // CVV2 incorrecto
  "503": "not_configured", // comercio no registrado en el procesador
  "526": "not_configured", // comercio sin permiso
  "554": "not_configured", // moneda no válida
  "558": "not_configured", // no permitida al comercio
  "581": "not_configured", // credenciales incorrectas
  "519": "unavailable", // error al procesar, reintentar
  "591": "unavailable", // emisor inoperativo
  "596": "unavailable", // problema del emisor al autorizar
};

/**
 * Lee `code` y `processorError` del body de error de Kushki (si es JSON).
 * Acepta string o número, recorta espacios y deja el `code` en mayúsculas
 * para que la tabla de arriba lo encuentre aunque venga como "k012".
 */
function parseKushkiBody(body: string): { code: string | null; processorError: string | null } {
  try {
    const json: unknown = JSON.parse(body);
    if (json && typeof json === "object") {
      const o = json as Record<string, unknown>;
      const str = (v: unknown) =>
        typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
      return { code: str(o.code)?.toUpperCase() ?? null, processorError: str(o.processorError) };
    }
  } catch {
    // body no-JSON (HTML de un proxy, texto plano…)
  }
  return { code: null, processorError: null };
}

function reasonFromHttpStatus(status: number): SubscriptionErrorReason {
  if (status === 401 || status === 403) return "not_configured"; // credenciales nuestras
  if (status === 404) return "not_found";
  if (status === 429 || status >= 500) return "unavailable";
  return "unknown";
}

/**
 * Kushki NO conoce esa suscripción con las credenciales en uso: K012 ("ID de
 * suscripción no válida") o HTTP 404. Pasa con suscripciones creadas cuando
 * la cuenta de cobro estaba en sandbox y hoy se consultan con las credenciales
 * de producción. Acepta un KushkiHttpError o cualquier objeto con `status`
 * numérico y `body` string (los consumidores que no hacen instanceof, p. ej.
 * restaurantDeletion/resolve.ts, lo ven así).
 */
export function isSubscriptionNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { status, body } = err as { status?: unknown; body?: unknown };
  if (status === 404) return true;
  if (typeof body !== "string") return false;
  return parseKushkiBody(body).code === "K012";
}

export function classifySubscriptionError(err: unknown): SubscriptionErrorInfo {
  if (err instanceof KushkiHttpError) {
    const { code, processorError } = parseKushkiBody(err.body);
    // processorError es el motivo del procesador (más específico que `code`).
    const reason =
      (processorError ? REASON_BY_CODE[processorError] : undefined) ??
      (code ? REASON_BY_CODE[code] : undefined) ??
      reasonFromHttpStatus(err.status);
    return { reason, providerCode: code ?? processorError };
  }
  if (err instanceof KushkiSchemaError) {
    return { reason: "unknown", providerCode: null };
  }
  if (err instanceof Error && err.message.startsWith("billing_not_configured")) {
    return { reason: "not_configured", providerCode: null };
  }
  // AbortSignal.timeout() → TimeoutError; red caída → TypeError "fetch failed".
  const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    (err instanceof TypeError && err.message === "fetch failed")
  ) {
    return { reason: "unavailable", providerCode: null };
  }
  return { reason: "unknown", providerCode: null };
}

/**
 * Status HTTP de la respuesta según el motivo. `not_found` cae en 502 como
 * `unknown`: al activar o cambiar tarjeta no debería pasar nunca y no tiene
 * copy propio (su tratamiento especial vive en restaurantDeletion/resolve.ts).
 */
export function subscriptionErrorHttpStatus(reason: SubscriptionErrorReason): number {
  switch (reason) {
    case "security_rejected":
    case "card_declined":
    case "card_invalid":
      return 402;
    case "not_configured":
      return 500;
    default:
      return 502;
  }
}
