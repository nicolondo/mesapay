// Cómo se PRESENTA cada fila de la lista de facturas electrónicas
// (/operator/facturas): el semáforo del estado DIAN, el motivo en una línea,
// el estado del correo y qué acción va a la vista y cuáles al menú «⋯».
// Puro —sin React ni DB— para poder probar las decisiones solas; los textos
// los pone la pantalla (`ElectronicInvoicesClient` / `InvoiceRow`).
import type { InvoiceDianStatus } from "@/lib/dian/invoiceList";
import {
  DUPLICATE_UNVERIFIED,
  STATUS_CHECK_UNAVAILABLE,
  parseDianMessage,
  type DianRecoveryAction,
  type DianRejectionCause,
} from "@/lib/dian/invoiceResponse";

/** Semáforo del estado DIAN (mismos tonos que `StatusBadge` de reportes). */
export type InvoiceStatusTone = "ok" | "warning" | "critical" | "info";

/**
 * Tono del estado: verde aceptada; rojo lo que espera a una persona
 * (rechazada, reintentos agotados); ámbar lo que va a resolverse solo pero
 * conviene mirar (error que se reintenta, frenada por configuración);
 * neutro lo que está en camino (en la DIAN, en la cola).
 */
export function invoiceStatusTone(status: InvoiceDianStatus, reason: string | null): InvoiceStatusTone {
  switch (status) {
    case "accepted":
      return "ok";
    case "rejected":
    case "error_stuck":
      return "critical";
    case "error_retrying":
      return "warning";
    case "not_sent":
      return reason ? "warning" : "info";
    case "in_process":
      return "info";
  }
}

/** Motivos de bloqueo con texto propio (`opFacturas.blockReason_*`). */
export const KNOWN_BLOCK_REASONS: ReadonlySet<string> = new Set([
  "no_config",
  "no_certificate",
  "missing_credentials",
  "master_key_missing",
  "decrypt_failed",
  "no_emisor",
  "resolution_incomplete",
  "location_incomplete",
  "contact_email_incomplete",
  "numbering_exhausted",
  "number_out_of_range",
  "no_lines",
  // La consulta del envío anterior no respondió (ver dian/invoiceResponse.ts).
  STATUS_CHECK_UNAVAILABLE,
  // La DIAN dijo tenerla (regla 90) y falta confirmarlo por CUFE.
  DUPLICATE_UNVERIFIED,
]);

/**
 * El motivo guardado (`lastError` o el primer error), desarmado para
 * mostrarlo en UNA línea:
 *
 *   · config → un código de configuración del comercio con traducción.
 *   · rule   → una regla de la DIAN ("Regla: FAK24, Rechazo: No está…"):
 *     el código va aparte, chiquito, y la frase de la DIAN queda sola.
 *   · text   → cualquier otro texto (falla de canal, SOAP Fault), tal cual.
 */
export type DianReason =
  | { kind: "config"; code: string }
  | { kind: "rule"; rule: string; text: string }
  | { kind: "text"; text: string };

export function parseDianReason(reason: string | null | undefined): DianReason | null {
  const raw = reason?.trim();
  if (!raw) return null;
  if (KNOWN_BLOCK_REASONS.has(raw)) return { kind: "config", code: raw };
  // El mismo lector de la emisión (dian/invoiceResponse.ts).
  const m = parseDianMessage(raw);
  if (m.rule) {
    const text = m.text.replace(/\s+/g, " ").trim();
    return { kind: "rule", rule: m.rule.toUpperCase(), text: text || raw };
  }
  return { kind: "text", text: raw.replace(/\s+/g, " ") };
}

/**
 * Clave del texto en lenguaje claro de una causa conocida
 * (`opEInvoices.cause_<clave>` / `causeDetail_<clave>`, ver
 * `dianRecoveryAdvice`). La «ya la tiene» todavía sin confirmar (la fila
 * en proceso) tiene su propio texto. null ⇒ la causa es «other»: se
 * muestra el motivo de siempre.
 */
export function adviceCauseKey(
  advice: { cause: DianRejectionCause } | null | undefined,
  status: InvoiceDianStatus,
): string | null {
  if (!advice || advice.cause === "other") return null;
  return status === "in_process" && advice.cause === "already_at_dian" ? "unverified" : advice.cause;
}

/** Estado del correo de la factura, como chip con ícono. */
export type InvoiceEmailStatus =
  /** Salió al correo del cliente. */
  | "sent"
  /** Nadie dejó correo: no es un error, se imprime. */
  | "no_recipient"
  /** Hubo correo pero el envío falló: se puede reenviar. */
  | "failed"
  /** Aceptada y con correo, el envío todavía no salió. */
  | "pending"
  /** La factura no está aceptada: el correo no aplica todavía. */
  | "not_applicable";

export function invoiceEmailStatus(d: {
  status: InvoiceDianStatus;
  emailedAt: string | null;
  emailError: string | null;
  emailTo: string | null;
}): InvoiceEmailStatus {
  if (d.status !== "accepted") return "not_applicable";
  if (d.emailedAt) return "sent";
  if (!d.emailTo || d.emailError === "no_recipient") return "no_recipient";
  if (d.emailError === "send_failed") return "failed";
  return "pending";
}

/** Acciones de una factura, en el orden en que salen en el menú. */
export type InvoiceActionId = "recover" | "retry" | "resend" | "reprint" | "view" | "order" | "creditNote";

const MENU_ORDER: readonly InvoiceActionId[] = ["view", "reprint", "resend", "recover", "retry", "order", "creditNote"];

/**
 * ¿Se puede reintentar la emisión a mano? Lo de siempre: lo que la DIAN
 * rechazó, lo que falló al enviarse y lo frenado por configuración. Lo que
 * está en cola sin motivo o en manos de la DIAN no se toca.
 */
export function canRetryEmission(status: InvoiceDianStatus, reason: string | null): boolean {
  return (
    status === "rejected" ||
    status === "error_retrying" ||
    status === "error_stuck" ||
    (status === "not_sent" && !!reason)
  );
}

/**
 * Qué acción va a la vista (UNA por fila) y cuáles al menú «⋯»:
 *
 *   · Lo que espera a una persona —rechazada, reintentos agotados, frenada—
 *     muestra «Reintentar».
 *   · Aceptada con el correo fallido muestra «Reenviar»; si no, «Reimprimir»
 *     (lo que más se pide en la caja).
 *   · Lo que va a resolverse solo (en la DIAN, en la cola, error que se
 *     reintenta) muestra «Ver factura»; el reintento manual queda en el menú.
 *
 * Con una causa conocida de la DIAN (`dianRecoveryAdvice`: producto en $0,
 * «ya la tiene», respuesta temporal) la recomendada —«Reenviar a la DIAN» o
 * «Consultar en la DIAN»— es la principal y reemplaza a «Reintentar», que
 * para esas causas no sirve (vuelve a fallar igual).
 *
 * El menú lleva el resto, sin repetir la principal. «Reenviar» y «Anular con
 * nota crédito» sólo existen con la factura ACEPTADA (antes no es fiscal).
 */
export function invoiceActionPlan(d: {
  status: InvoiceDianStatus;
  reason: string | null;
  emailError: string | null;
  /** Acción recomendada por `dianRecoveryAdvice` (null / "none" ⇒ ninguna). */
  recovery?: DianRecoveryAction | null;
}): { primary: InvoiceActionId; menu: InvoiceActionId[] } {
  const accepted = d.status === "accepted";
  const recover = !accepted && (d.recovery === "resend" || d.recovery === "check_status");
  const retry = !recover && canRetryEmission(d.status, d.reason);
  const available = new Set<InvoiceActionId>(["view", "reprint", "order"]);
  if (accepted) {
    available.add("resend");
    available.add("creditNote");
  }
  if (retry) available.add("retry");
  if (recover) available.add("recover");

  let primary: InvoiceActionId;
  if (recover) primary = "recover";
  else if (retry && d.status !== "error_retrying") primary = "retry";
  else if (accepted && d.emailError === "send_failed") primary = "resend";
  else if (accepted) primary = "reprint";
  else primary = "view";

  return { primary, menu: MENU_ORDER.filter((a) => a !== primary && available.has(a)) };
}

/** «Mostrando X–Y de N»: los números de la página que se ve. */
export function invoicePageRange(page: number, rowsOnPage: number, pageSize: number): { from: number; to: number } {
  if (rowsOnPage <= 0) return { from: 0, to: 0 };
  const from = (Math.max(1, page) - 1) * pageSize + 1;
  return { from, to: from + rowsOnPage - 1 };
}
