import { declineReasonForCode, KNOWN_DECLINE_CODES, type KushkiDeclineReason } from "./declineReason";

/**
 * ¿Qué pasó cuando `chargeWithToken` (tarjeta / Apple Pay) LANZÓ?
 *
 * `kushkiFetch` lanza `KushkiHttpError` para toda respuesta no-2xx, y los
 * rechazos de Kushki llegan justamente así (4xx con `{ code, message }`).
 * Tratar cualquier excepción como «incierta» deja el pago `pending` para
 * siempre: al comensal «Estamos verificando tu pago» y la mesa bloqueada.
 * Tratar cualquiera como «rechazada» es peor: se libera una cuenta que quizá
 * SÍ se cobró y alguien la vuelve a cobrar.
 *
 * Tabla de decisión (se evalúa de arriba hacia abajo; ante la duda, incierto):
 *
 *   Lo que lanzó el cobro                                        Resultado
 *   ───────────────────────────────────────────────────────────  ─────────
 *   No es una respuesta HTTP de Kushki:
 *     · TimeoutError / AbortError (30 s sin respuesta)           INCIERTO  (timeout)
 *     · TypeError «fetch failed» (red caída, DNS, TLS)           INCIERTO  (network)
 *     · KushkiSchemaError (2xx que no parsea: Kushki SÍ          INCIERTO  (schema)
 *       respondió con éxito y no sabemos qué)
 *     · cualquier otra excepción                                 INCIERTO  (unknown)
 *   HTTP 5xx                                                     INCIERTO  (http_5xx)
 *   HTTP fuera de 400–499 (redirección, etc.)                    INCIERTO  (http_status)
 *   HTTP 408, 409, 425, 429 (timeout, conflicto, reintento       INCIERTO  (http_ambiguous)
 *     prematuro, límite de peticiones: la petición original
 *     pudo haberse procesado)
 *   4xx con cuerpo no reconocible (HTML de un proxy, vacío,      INCIERTO  (unrecognized_body)
 *     JSON sin `code` ni `message`)
 *   4xx con `code`/`processorError` de token ya usado o          INCIERTO  (token_reuse)
 *     vencido (577, K049): un intento previo con ese token
 *     pudo haber cobrado
 *   4xx con `code`/`processorError` de fallo transitorio del     INCIERTO  (processor_unavailable)
 *     gateway o del procesador (K003, K027, K035, K046;
 *     519, 591, 596): el procesador pudo haber autorizado
 *   4xx con un `code` de rechazo conocido (K322, 017, 021,       RECHAZO   (su motivo)
 *     022, 023, K040: los de `declineReason.ts`). Gana sobre
 *     las pistas del mensaje de la fila siguiente
 *   4xx con otro `code`, o sólo `message`, cuyo texto nombra     INCIERTO  (token_reuse /
 *     el token, un timeout, un error inesperado, un servicio                processor_unavailable)
 *     no disponible o una transacción duplicada / en proceso
 *   Cualquier otro 4xx con `code` o `message` de Kushki          RECHAZO   (charge_failed;
 *     (K220, K001, 401/403 de credenciales…)                               merchant_config en 401/403)
 *
 * Por qué un 4xx reconocible es definitivo: Kushki contestó, entendió la
 * petición y dijo que NO. Si aun así llegara una aprobación tardía por
 * webhook, `settleKushkiEventInTx` la aplica y la marca para revisión
 * (`lateApproval`): nunca se pierde un cobro.
 *
 * Los códigos salen de lo documentado en el repo: `declineReason.ts`, el
 * historial de `kushki-charge` (577 = «token ya usado») y la tabla de
 * `lib/billing/subscriptionErrors.ts` (K049 = token usado en pagos únicos;
 * K003/K027/K035/K046 y 519/591/596 = gateway o procesador no disponible).
 * Esa última tabla es la de cargos RECURRENTES: en pagos únicos un K-código
 * puede significar otra cosa, pero dejarlo incierto es el lado seguro (a lo
 * sumo alguien concilia a mano un rechazo; nunca se libera un cobro dudoso).
 * La doc de códigos de Kushki pide contraseña: si aparece un código nuevo en
 * el log `charge_uncertain` / `charge_declined`, se agrega acá o en
 * `declineReason.ts`.
 *
 * Archivo sin dependencias de servidor: reconoce el error por su forma
 * (`status` numérico + `body` string, como `KushkiHttpError`), no con
 * `instanceof`, para no arrastrar `env`.
 */

/** Rechazo definitivo: Kushki dijo que no. El pago se liquida como rechazado. */
export type KushkiChargeDeclined = {
  outcome: "declined";
  reason: KushkiDeclineReason;
  httpStatus: number;
  /** `code` de Kushki normalizado (p. ej. "K322"); null si sólo vino `message`. */
  code: string | null;
  /** `message` de Kushki, recortado. Para la auditoría, NUNCA para los logs. */
  message: string | null;
  errorName: string;
};

export type KushkiChargeUncertainCause =
  | "timeout"
  | "network"
  | "schema"
  | "unknown"
  | "http_5xx"
  | "http_status"
  | "http_ambiguous"
  | "unrecognized_body"
  | "token_reuse"
  | "processor_unavailable";

/** No se sabe si se cobró: el pago queda pendiente, para conciliar. */
export type KushkiChargeUncertain = {
  outcome: "uncertain";
  cause: KushkiChargeUncertainCause;
  httpStatus: number | null;
  code: string | null;
  errorName: string;
};

export type KushkiChargeFailure = KushkiChargeDeclined | KushkiChargeUncertain;

/** 4xx donde la petición original pudo haberse procesado. */
const AMBIGUOUS_HTTP_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429]);

/** Token ya usado o vencido: un intento previo con ese token pudo haber cobrado. */
const TOKEN_REUSE_CODES: ReadonlySet<string> = new Set(["577", "K049"]);

/** Fallo transitorio del gateway o del procesador: pudo haber autorizado. */
const PROCESSOR_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "K003", // error en la respuesta del gateway
  "K027", // no se pudo completar / timeout
  "K035", // procesador no disponible
  "K046", // timeout
  "519", // error al procesar, reintentar
  "591", // emisor inoperativo
  "596", // problema del emisor al autorizar
]);

// Pistas en el texto, sólo para códigos que no conocemos (sin tildes, en
// minúsculas). Mejor dejar incierto un rechazo que liberar un cobro dudoso.
const TOKEN_HINT = /token/;
const AMBIGUOUS_HINT =
  /time.?out|timed out|tiempo de espera|agotad|inesperad|unexpected|no disponible|unavailable|inalcanzable|unreachable|duplicad|duplicate|en proceso|in process|in progress|pendiente|pending|reintent|intent[ae] (de nuevo|nuevamente|mas tarde)|try again/;

const MESSAGE_MAX = 200;

function errorName(err: unknown): string {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  }
  return "unknown";
}

/** Forma de `KushkiHttpError`: `status` numérico y `body` string. */
function asHttpError(err: unknown): { status: number; body: string } | null {
  if (!err || typeof err !== "object") return null;
  const { status, body } = err as { status?: unknown; body?: unknown };
  return typeof status === "number" && typeof body === "string" ? { status, body } : null;
}

/** `code` como lo escribe la doc de Kushki: "K322", "021" (3 dígitos). */
function normalizeCode(value: unknown): string | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const upper = raw.toUpperCase();
  return /^\d{1,2}$/.test(upper) ? upper.padStart(3, "0") : upper;
}

/** Lee `code`, `processorError` y `message` del cuerpo de error de Kushki. */
function parseErrorBody(body: string): { code: string | null; processorError: string | null; message: string | null } | null {
  try {
    const json: unknown = JSON.parse(body);
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    const o = json as Record<string, unknown>;
    const message = typeof o.message === "string" && o.message.trim() ? o.message.trim().slice(0, MESSAGE_MAX) : null;
    const code = normalizeCode(o.code);
    if (!code && !message) return null;
    return { code, processorError: normalizeCode(o.processorError), message };
  } catch {
    // Cuerpo no-JSON: HTML de un proxy, texto plano, vacío.
    return null;
  }
}

const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Clasifica lo que lanzó `chargeWithToken`. Ver la tabla de arriba. */
export function classifyKushkiChargeError(err: unknown): KushkiChargeFailure {
  const name = errorName(err);
  const uncertain = (
    cause: KushkiChargeUncertainCause,
    httpStatus: number | null = null,
    code: string | null = null,
  ): KushkiChargeUncertain => ({ outcome: "uncertain", cause, httpStatus, code, errorName: name });

  const http = asHttpError(err);
  if (!http) {
    if (name === "TimeoutError" || name === "AbortError") return uncertain("timeout");
    if (name === "KushkiSchemaError") return uncertain("schema");
    if (err instanceof TypeError) return uncertain("network");
    return uncertain("unknown");
  }

  const { status } = http;
  const parsed = parseErrorBody(http.body);
  const code = parsed?.code ?? parsed?.processorError ?? null;
  if (status >= 500) return uncertain("http_5xx", status, code);
  if (status < 400) return uncertain("http_status", status, code);
  if (AMBIGUOUS_HTTP_STATUS.has(status)) return uncertain("http_ambiguous", status, code);
  if (!parsed) return uncertain("unrecognized_body", status);

  // `processorError` (el motivo crudo del procesador) sólo se usa para
  // DUDAR: nunca convierte un error en rechazo definitivo.
  const codes = [parsed.code, parsed.processorError].filter((c): c is string => !!c);
  if (codes.some((c) => TOKEN_REUSE_CODES.has(c))) return uncertain("token_reuse", status, code);
  if (codes.some((c) => PROCESSOR_UNAVAILABLE_CODES.has(c))) return uncertain("processor_unavailable", status, code);

  const declined = (reason: KushkiDeclineReason): KushkiChargeDeclined => ({
    outcome: "declined",
    reason,
    httpStatus: status,
    code,
    message: parsed.message,
    errorName: name,
  });

  if (parsed.code && KNOWN_DECLINE_CODES.has(parsed.code)) return declined(declineReasonForCode(parsed.code));

  const text = parsed.message ? plain(parsed.message) : "";
  if (TOKEN_HINT.test(text)) return uncertain("token_reuse", status, code);
  if (AMBIGUOUS_HINT.test(text)) return uncertain("processor_unavailable", status, code);

  // Credenciales del comercio (llave privada mala o deshabilitada): nunca
  // llegó a cobrarse, y lo que hay que revisar es la configuración.
  if (!code && (status === 401 || status === 403)) return declined("merchant_config");
  return declined(declineReasonForCode(parsed.code));
}

/**
 * Lo que va al log de un cobro fallido: clase, status HTTP, `code` de Kushki
 * y el nombre real del error. Nunca el cuerpo ni el mensaje de Kushki (pueden
 * traer datos del titular), ni tokens, ni llaves.
 */
export function chargeFailureLogFields(failure: KushkiChargeFailure) {
  return failure.outcome === "declined"
    ? { outcome: failure.outcome, reason: failure.reason, status: failure.httpStatus, code: failure.code, name: failure.errorName }
    : { outcome: failure.outcome, cause: failure.cause, status: failure.httpStatus, code: failure.code, name: failure.errorName };
}
