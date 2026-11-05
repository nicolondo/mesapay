// Qué QUISO DECIR la DIAN con la respuesta a una factura de venta.
//
// `parseDianResponse` (soap.ts) es estructural: IsValid, StatusCode y la
// lista de mensajes. Lo que decide si una factura queda rechazada, se
// reintenta sola o hay que preguntarle a la DIAN si ya la tiene vive acá,
// puro (sin DB ni red) y en un solo lugar: lo usan la emisión, la consulta
// de estado, la pantalla de Facturas y la herramienta de recuperación.
//
// Las reglas, del Anexo Técnico (1.8, Res. 000012/2021, tabla 6, pág. 25;
// igual en el 1.9, Res. 000165/2023): cada regla de validación tiene un
// efecto, «R: Rechazo, el procesamiento correspondiente ha encontrado
// problemas que impiden el procesamiento» o «N: Notificación … indicios de
// potenciales problemas, los cuales NO impiden el procesamiento». La DIAN
// los manda así: «Regla: FAW01, Rechazo: …» / «Regla: RUT01, Notificación: …».
import type { DianResult } from "@/lib/dian/soap";

export type DianMessageKind = "rejection" | "notification";

export type DianMessage = {
  /** Código de la regla ("FAW01", "90", "RUT01") o null si el texto no lo trae. */
  rule: string | null;
  kind: DianMessageKind;
  /** El mensaje sin el prefijo «Regla: X, Rechazo:». */
  text: string;
  /** El mensaje tal cual llegó. */
  raw: string;
};

const RULE_RE = /^\s*Regla\s*:\s*([^,]+?)\s*,\s*(Rechazo|Notificaci\S*n)\s*:?\s*([\s\S]*)$/i;

/**
 * Un mensaje de la DIAN. Lo que no trae el formato «Regla: X, Efecto: …» se
 * trata como RECHAZO: es lo conservador (un texto suelto en ErrorMessage con
 * IsValid=false nunca puede volver aceptada una factura).
 *
 * «Notificaci\S*n» y no «Notificación» a secas: un mensaje guardado con la
 * tilde rota («Notificaci�n», ver `decodeSoapBody`) sigue siendo una
 * notificación.
 */
export function parseDianMessage(raw: string): DianMessage {
  const m = RULE_RE.exec(raw);
  if (!m) return { rule: null, kind: "rejection", text: raw.trim(), raw };
  return {
    rule: m[1].trim(),
    kind: /^rechazo$/i.test(m[2]) ? "rejection" : "notification",
    text: m[3].trim(),
    raw,
  };
}

/**
 * «Regla: 90, Rechazo: Documento procesado anteriormente.» — la DIAN YA
 * tiene un documento con este número. No es un rechazo del contenido: casi
 * siempre es un intento anterior que la DIAN aceptó y cuya respuesta se
 * perdió (timeout). OJO: es la REGLA 90 del ErrorMessage, no el StatusCode
 * 90 de GetStatus («TrackId no encontrado»).
 */
export function isDuplicateMessage(m: DianMessage): boolean {
  return (
    m.kind === "rejection" &&
    (m.rule === "90" || /procesad[oa]\s+anteriormente|already\s+processed/i.test(m.text))
  );
}

/** FAW01: una línea en $0 sin precio de referencia (ver `billableDianLines`). */
export function isZeroValueLineMessage(m: DianMessage): boolean {
  return m.kind === "rejection" && m.rule?.toUpperCase() === "FAW01";
}

/**
 * Falla de la plataforma de la DIAN, no del documento: el texto trae una
 * variable de plantilla SIN reemplazar («el estado de su RUT es
 * {StatusRut}»). Una DIAN que no alcanzó a armar su propio mensaje no
 * evaluó la factura: se reintenta más tarde, no se da por rechazada.
 */
export function isTransientGlitch(m: DianMessage): boolean {
  return m.kind === "rejection" && /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(m.text);
}

export type InvoiceVerdict =
  /** Validada. `warnings`: las notificaciones que vinieron igual. */
  | { kind: "accepted"; warnings: string[] }
  /** La DIAN la está procesando (envío asíncrono / lote en validación). */
  | { kind: "pending"; warnings: string[] }
  /** Falla de canal: timeout, fault, respuesta ilegible. Nada se sabe del documento. */
  | { kind: "channel_error"; warnings: string[] }
  /** Regla 90: la DIAN ya tiene este número. Hay que consultar por CUFE. */
  | { kind: "duplicate"; warnings: string[] }
  /**
   * No se aceptó, pero tampoco hay un rechazo real del contenido: sólo
   * notificaciones (`notification_only`) o rechazos con la plantilla sin
   * armar (`platform_glitch`). Se reintenta más tarde, con tope.
   */
  | { kind: "transient"; reason: "notification_only" | "platform_glitch"; warnings: string[] }
  /** Consulta de estado: la DIAN no tiene ese CUFE (StatusCode 66/90, sin reglas). */
  | { kind: "not_found"; warnings: string[] }
  /** Rechazo real: hay que corregir algo. */
  | { kind: "rejected"; warnings: string[] };

function splitMessages(errors: readonly string[]) {
  const messages = errors.filter((e) => e.trim().length > 0).map(parseDianMessage);
  return {
    messages,
    rejections: messages.filter((m) => m.kind === "rejection"),
    notifications: messages.filter((m) => m.kind === "notification").map((m) => m.raw),
  };
}

/**
 * El veredicto de una respuesta (envío o consulta). Sólo los RECHAZOS
 * reales hacen una factura rechazada; las notificaciones nunca (quedan como
 * advertencias).
 */
export function classifyInvoiceResponse(
  result: Pick<DianResult, "state" | "statusCode" | "errors">,
): InvoiceVerdict {
  const { rejections, notifications } = splitMessages(result.errors ?? []);
  const warnings = notifications;
  switch (result.state) {
    case "accepted":
      return { kind: "accepted", warnings };
    case "pending":
      return { kind: "pending", warnings };
    case "error":
      return { kind: "channel_error", warnings };
  }
  if (rejections.some(isDuplicateMessage)) return { kind: "duplicate", warnings };
  const code = result.statusCode?.trim();
  if (rejections.length === 0 && (code === "66" || code === "90")) {
    return { kind: "not_found", warnings };
  }
  if (rejections.length === 0) {
    // IsValid=false con sólo notificaciones: la DIAN no la validó pero no
    // dijo qué está mal. No es un rechazo; se vuelve a intentar.
    return notifications.length > 0
      ? { kind: "transient", reason: "notification_only", warnings }
      : { kind: "rejected", warnings };
  }
  if (rejections.every(isTransientGlitch)) {
    return { kind: "transient", reason: "platform_glitch", warnings };
  }
  return { kind: "rejected", warnings };
}

// ── Lo que ve el operador ───────────────────────────────────────────────

/**
 * `lastError` de una factura que la DIAN dice tener (regla 90) pero que
 * todavía no pudimos confirmar por CUFE. Queda en `pending`: no es un
 * rechazo, y la consulta de estado (botón, barrido, recuperación) la cierra.
 */
export const DUPLICATE_UNVERIFIED = "dian_duplicate_unverified";

/**
 * `lastError` de un reintento que NO salió porque la consulta del envío
 * anterior (GetStatus por CUFE) no respondió: mandar un documento nuevo sin
 * saber si la DIAN ya aceptó el anterior es justamente lo que produce la
 * regla 90. Se reintenta con backoff.
 */
export const STATUS_CHECK_UNAVAILABLE = "dian_status_unavailable";

/**
 * Por qué no está aceptada, en palabras del operador. Sale de los mensajes
 * guardados (`errors`), así que sirve también para los documentos que se
 * rechazaron antes de este cambio.
 */
export type DianRejectionCause =
  /** FAW01: una línea en $0. Ya no se manda: se reenvía y sale. */
  | "zero_value_line"
  /** Regla 90: la DIAN ya la tiene. Se consulta por CUFE. */
  | "already_at_dian"
  /** Sólo notificaciones (p. ej. RUT01 «próximamente estará disponible»). */
  | "dian_notification"
  /** Falla de la DIAN (plantilla sin armar, «{StatusRut}»). */
  | "dian_transient"
  /** Cualquier otro rechazo: hay que corregir el dato. */
  | "other";

export type DianRecoveryAction =
  /** «Reenviar a la DIAN»: se arma el XML de nuevo y sale con el MISMO número. */
  | "resend"
  /** «Consultar en la DIAN»: GetStatus por CUFE; si la tiene, queda aceptada. */
  | "check_status"
  /** Nada automático: hay que corregir el dato y usar «Reintentar emisión». */
  | "none";

export function dianRejectionCause(doc: {
  lastError?: string | null;
  errors: readonly string[];
}): DianRejectionCause {
  if (doc.lastError === DUPLICATE_UNVERIFIED) return "already_at_dian";
  const { rejections, notifications } = splitMessages(doc.errors);
  if (rejections.some(isDuplicateMessage)) return "already_at_dian";
  const real = rejections.filter((m) => !isTransientGlitch(m));
  if (real.length > 0) return real.every(isZeroValueLineMessage) ? "zero_value_line" : "other";
  if (rejections.length > 0) return "dian_transient";
  return notifications.length > 0 ? "dian_notification" : "other";
}

/** La acción que resuelve cada causa ("none" ⇒ hay que corregir algo primero). */
export function recoveryActionFor(cause: DianRejectionCause): DianRecoveryAction {
  switch (cause) {
    case "zero_value_line":
    case "dian_notification":
    case "dian_transient":
      return "resend";
    case "already_at_dian":
      return "check_status";
    default:
      return "none";
  }
}

/**
 * Lo que la pantalla necesita de una factura que no salió: la causa (de ahí
 * sale el texto en lenguaje claro, `opEInvoices.cause_<causa>` y
 * `causeDetail_<causa>`) y la acción recomendada. Pura: la consumen la
 * lista de Facturas, la herramienta de recuperación del admin y quien
 * rediseñe la fila.
 */
export function dianRecoveryAdvice(doc: {
  state: string;
  lastError?: string | null;
  errors: readonly string[];
}): { cause: DianRejectionCause; action: DianRecoveryAction } | null {
  const waitingCheck = doc.state === "pending" && doc.lastError === DUPLICATE_UNVERIFIED;
  if (doc.state !== "rejected" && doc.state !== "error" && !waitingCheck) return null;
  const cause = dianRejectionCause(doc);
  // Un error de canal ("timeout") no es un rechazo: lo resuelve el
  // reintento de siempre, no una acción nueva.
  if (doc.state === "error" && cause === "other") return null;
  return { cause, action: recoveryActionFor(cause) };
}

/** Un CUFE/CUDE: SHA-384 en hexadecimal. */
export function isCufe(value: string | null | undefined): value is string {
  return !!value && /^[0-9a-f]{96}$/i.test(value.trim());
}
