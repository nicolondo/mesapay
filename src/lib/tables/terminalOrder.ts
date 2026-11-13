import type { TableVisualState } from "@/lib/walkoutRisk";
import {
  isPhonePaidHighlighted,
  sortTablesForSalon,
  type SalonSortOptions,
  type SalonSortable,
} from "./sortTables";

/**
 * Orden de "Mesas en vivo" del datáfono (`/terminal`).
 *
 * Pedido del dueño: "el orden de las mesas no está bien como lo habíamos
 * puesto para el admin, que las mesas activas están de primero". El datáfono
 * ordenaba por su cuenta (las que pidieron datáfono/efectivo arriba y TODO lo
 * demás por número, con las pagadas mezcladas entre las abiertas). Ahora usa
 * la regla del salón tal cual — `sortTablesForSalon` — y acá sólo vive la
 * traducción del estado del datáfono al del salón:
 *
 *   datáfono                                   salón (SalonSortable)
 *   ─────────────────────────────────────────  ──────────────────────────────
 *   free                                       free
 *   paid                                       recently_paid (+ paidAt y
 *                                              paidFromPhone)
 *   occupied · partial · charging ·            active, con el `visualState`
 *   terminal_requested · cash_requested        del salón y `needsWaiter`
 *
 * Resultado: primero la mesa que acaba de pagar desde el celular (mientras
 * dure el resalte del comercio), después TODAS las cuentas abiertas — riesgo
 * de fuga, cobro pedido ya envejecido, cobro pedido / mesero llamado, y el
 * resto —, y al final las pagadas y las libres, cada grupo por número.
 *
 * Diferencias con la vista Mesas del admin (a propósito, no cambian el orden
 * de las cuentas abiertas):
 *   - Allá una mesa pagada vuelve a "libre" a los 15 minutos; acá sigue
 *     diciendo "Pagada" hasta que se abra otra cuenta. Las dos van al final
 *     y por número, así que el orden es el mismo.
 *   - Sin `visualState` (una lista que no lo calculó) se deduce del estado
 *     del datáfono: con un pago pendiente la mesa cuenta como "cobro pedido";
 *     si no, como cuenta abierta sin urgencia. Nunca cae debajo de una pagada.
 *
 * Función pura, sin dependencias de servidor: la usa la grilla (cliente).
 */

export type TerminalTableState =
  | "free"
  | "occupied"
  | "partial"
  | "charging"
  | "terminal_requested"
  | "cash_requested"
  | "paid";

/** Lo que hace falta de cada mesa del datáfono para ordenarla. */
export type TerminalSortable = {
  number: number;
  label?: string | null;
  state: TerminalTableState;
  /**
   * Estado visual del salón para una cuenta abierta (`salonVisualStateOf`,
   * el mismo cálculo de /operator/tables). Null/ausente en libres y pagadas.
   */
  visualState?: TableVisualState | null;
  /** La mesa llamó al mesero y nadie atendió todavía. */
  needsWaiter?: boolean;
  /** Sólo `paid`: cuándo se cerró la cuenta (ISO). */
  paidAt?: string | null;
  /** Sólo `paid`: la cerró el comensal desde su celular. */
  paidFromPhone?: boolean;
};

/** Estados del datáfono con un pago pendiente en la cuenta. */
const PENDING_PAYMENT_STATES: ReadonlySet<TerminalTableState> = new Set([
  "charging",
  "terminal_requested",
  "cash_requested",
]);

/** La mesa del datáfono vista con los ojos del salón. */
export function toSalonSortable(t: TerminalSortable): SalonSortable {
  const identity = { number: t.number, label: t.label ?? null };
  if (t.state === "free") return { ...identity, state: "free" };
  if (t.state === "paid") {
    return {
      ...identity,
      state: "recently_paid",
      paidAt: t.paidAt ?? null,
      paidFromPhone: t.paidFromPhone === true,
    };
  }
  return {
    ...identity,
    state: "active",
    visualState:
      t.visualState ??
      (PENDING_PAYMENT_STATES.has(t.state) ? "needs_payment" : "eating"),
    order: { needsWaiter: t.needsWaiter === true },
  };
}

/**
 * ¿Esta mesa acaba de pagar desde el celular y sigue en su ventana de
 * resalte? Es la que va de primera (y la grilla pinta de verde fuerte).
 */
export function isTerminalPhonePaidHighlighted(
  t: TerminalSortable,
  opts: SalonSortOptions | undefined,
): boolean {
  return isPhonePaidHighlighted(toSalonSortable(t), opts);
}

/**
 * Las mesas del datáfono en el orden del salón. No muta la entrada y
 * devuelve los mismos objetos que recibió (sólo cambia el orden).
 */
export function sortTablesForTerminal<T extends TerminalSortable>(
  tables: readonly T[],
  opts?: SalonSortOptions,
): T[] {
  const keyed = tables.map((table) => ({ ...toSalonSortable(table), table }));
  return sortTablesForSalon(keyed, opts).map((k) => k.table);
}
