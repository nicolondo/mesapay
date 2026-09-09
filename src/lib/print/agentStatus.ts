/**
 * "¿El agente de la cocina está vivo?" — la única pregunta que la
 * pantalla de configuración tiene que contestar bien.
 *
 * El agente toca `lastSeenAt` tanto al latir como al pedir trabajos, así
 * que un agente sano lo refresca cada pocos segundos. Todo lo que sigue
 * es leer esa marca; es puro para poder testearlo sin reloj real.
 */

/**
 * Hasta acá se considera "responde". El agente late seguido; 90s deja
 * pasar un ciclo perdido (red del local, el PC despertando) sin pintar
 * una alarma que en 10 segundos se apaga sola.
 */
export const AGENT_ONLINE_MS = 90 * 1000;

/**
 * Zona gris: ya no está latiendo como debería, pero tampoco es "el PC
 * está apagado". Vale la pena mostrarlo distinto de ambos: es el estado
 * donde una comanda TODAVÍA puede salir tarde en vez de no salir.
 */
export const AGENT_LATE_MS = 10 * 60 * 1000;

export type AgentState = "never" | "online" | "late" | "offline";

export type AgentLiveness = {
  state: AgentState;
  /** Milisegundos desde el último contacto. 0 si nunca contactó. */
  sinceMs: number;
  /** Ya redondeado para mostrar: "hace 40 s", "hace 12 min". */
  ago: { unit: "seconds" | "minutes" | "hours" | "days"; value: number } | null;
};

export function agentLiveness(
  lastSeenAt: Date | string | null | undefined,
  now: Date,
): AgentLiveness {
  if (!lastSeenAt) return { state: "never", sinceMs: 0, ago: null };
  const seen =
    lastSeenAt instanceof Date ? lastSeenAt : new Date(lastSeenAt);
  if (Number.isNaN(seen.getTime())) {
    return { state: "never", sinceMs: 0, ago: null };
  }
  // Un reloj adelantado del lado del agente no debe dar "hace -3 s".
  const sinceMs = Math.max(0, now.getTime() - seen.getTime());
  const state: AgentState =
    sinceMs < AGENT_ONLINE_MS
      ? "online"
      : sinceMs < AGENT_LATE_MS
        ? "late"
        : "offline";
  return { state, sinceMs, ago: humanizeAgo(sinceMs) };
}

/**
 * Cuánto hace, en la unidad más grande que todavía dice algo útil. No
 * devuelve texto: la pantalla elige la clave i18n con `unit` y le pasa
 * `value` — así "hace 12 min" existe en los tres idiomas sin que este
 * módulo sepa de i18n.
 */
export function humanizeAgo(ms: number): AgentLiveness["ago"] {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return { unit: "seconds", value: Math.max(0, seconds) };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { unit: "minutes", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", value: hours };
  return { unit: "days", value: Math.floor(hours / 24) };
}
