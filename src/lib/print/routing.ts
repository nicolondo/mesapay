/**
 * Reglas puras del encolado — separadas de `enqueue.ts` porque ese
 * módulo es `server-only` (toca DB e i18n) y estas dos decisiones son
 * las que hay que poder testear sin levantar nada.
 */

/** Las dos estaciones que imprimen comanda. `counter` no prepara nada. */
export type TicketStation = "kitchen" | "bar";

/**
 * Clave de idempotencia del encolado. El KDS marca los platos UNO POR
 * UNO, así que la misma ronda dispara la transición varias veces; sin
 * esto la cocina recibiría una copia de la comanda por cada plato.
 * Se apoya en @@unique([printerId, dedupeKey]) + skipDuplicates.
 */
export function ticketDedupeKey(
  roundId: string,
  station: TicketStation,
  barSubStation: string | null,
): string {
  return `${roundId}:${station}:${barSubStation ?? ""}`;
}

/**
 * ¿Esta impresora tiene que imprimir esta comanda? Misma semántica que
 * el filtro de /operator/print/bar?sub=…: una impresora SIN sub-estación
 * es "de toda la barra" y recibe todo lo del bar; con sub-estación sólo
 * recibe la suya.
 */
export function printerMatches(
  printer: { station: TicketStation | string; barSubStation: string | null },
  station: TicketStation,
  barSubStation: string | null,
): boolean {
  if (printer.station !== station) return false;
  if (printer.barSubStation === null) return true;
  return printer.barSubStation === barSubStation;
}
