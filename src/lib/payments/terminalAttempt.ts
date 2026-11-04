/**
 * Un cobro del datáfono Kushki YA enviado al equipo (reclamo
 * `terminal:<paymentId>`) y todavía `pending`: ¿qué sabemos de él? De eso
 * depende qué puede hacer el staff para destrabar la cuenta.
 *
 *   - `in_flight`: el cobro síncrono (`terminal/charge`, hasta ~95 s) todavía
 *     puede estar esperando la tarjeta. Lo único que se ofrece es
 *     «Cancelar en el datáfono» (abort): el equipo deja de esperar y el cobro
 *     vuelve con la respuesta de la cancelación, que libera la cuenta sola.
 *     NUNCA se marca rechazado acá: la respuesta todavía puede ser aprobado.
 *   - `answered`: el datáfono contestó que NO aprobó, con un código que no es
 *     definitivo (p. ej. "ocupado con otra transacción"). El cobro síncrono ya
 *     terminó. Cualquiera que pueda cobrar la mesa (mesero incluido) puede
 *     «Reintentar en el datáfono» o «Cancelar y cobrar de otra forma» al
 *     instante, confirmando en la pantalla del equipo que no salió.
 *   - `no_answer`: no hubo respuesta (timeout, red, 5xx) o pasó demasiado
 *     tiempo: el equipo PUDO cobrar. Sólo el administrador, pasados 3 minutos
 *     y con evidencia ("Resolver cobro", ver terminalResolve.ts).
 *
 * Archivo sin dependencias de servidor: lo usan la ruta
 * `/api/operator/payments/[id]/terminal-attempt` y las pantallas.
 */

/**
 * Hasta cuándo, desde el envío, el intento sigue "en curso": el cobro
 * síncrono puede esperar la tarjeta ~90 s y, si su respuesta no llega (el
 * gateway de Kushki corta a los 60 s), `terminal/charge` consulta el
 * resultado en Kushki hasta los 135 s (TERMINAL_RECOVERY_WINDOW_MS). Pasado
 * esto sin respuesta, es `no_answer`.
 */
export const TERMINAL_IN_FLIGHT_MAX_MS = 150_000;

export type TerminalAttemptState = "in_flight" | "answered" | "no_answer";

/** Lo que las pantallas reciben de un intento enviado al datáfono. */
export type TerminalAttemptView = {
  /** Cuándo se envió al equipo (ISO). */
  pushedAt: string;
  /** Cuándo contestó el equipo que no aprobó (ISO); null = sin respuesta. */
  answeredAt: string | null;
  /** "TERMINAL/TER-003": lo que contestó el equipo. */
  answerCode: string | null;
  answerMessage: string | null;
  /**
   * El cobro terminó sin respuesta (o lo marcó la conciliación): el pago
   * tiene `reconciliationRequired`. Con respuesta del equipo no importa.
   */
  uncertain: boolean;
};

type ClaimLike = {
  createdAt: Date;
  answerCode?: string | null;
  answerMessage?: string | null;
  answeredAt?: Date | null;
};

/** El intento como lo necesita la pantalla; null si nunca se envió. */
export function toTerminalAttemptView(
  claim: ClaimLike | null | undefined,
  reconciliationRequired: boolean,
): TerminalAttemptView | null {
  if (!claim) return null;
  return {
    pushedAt: claim.createdAt.toISOString(),
    answeredAt: claim.answeredAt ? claim.answeredAt.toISOString() : null,
    answerCode: claim.answerCode ?? null,
    answerMessage: claim.answerMessage ?? null,
    uncertain: reconciliationRequired,
  };
}

/** En qué estado está el intento AHORA (`now` en ms epoch). */
export function terminalAttemptState(
  attempt: Pick<TerminalAttemptView, "pushedAt" | "answeredAt" | "uncertain">,
  now: number,
): TerminalAttemptState {
  if (attempt.answeredAt) return "answered";
  if (attempt.uncertain) return "no_answer";
  const pushed = Date.parse(attempt.pushedAt);
  if (!Number.isFinite(pushed)) return "no_answer";
  return now - pushed < TERMINAL_IN_FLIGHT_MAX_MS ? "in_flight" : "no_answer";
}

/**
 * Quién puede cerrar un intento con respuesta del equipo (reintentar o
 * cancelar) o pedirle al equipo que cancele uno en curso: los mismos que
 * cobran la mesa, mesero incluido. "Solo el administrador cobra" lo bloquea
 * aparte (chargeGuard), como a cualquier cobro.
 */
const ATTEMPT_ROLES: readonly string[] = ["operator", "platform_admin", "group_admin", "terminal", "mesero"];

export function canHandleTerminalAttempt(role: string | null | undefined): boolean {
  return !!role && ATTEMPT_ROLES.includes(role);
}

/** Motivo del rechazo que ve el comensal cuando se canceló en el datáfono. */
export const TERMINAL_CANCELED_REASON = "terminal_canceled";
