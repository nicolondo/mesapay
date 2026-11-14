import type { TableVisualState } from "@/lib/walkoutRisk";
import { isCashMethod } from "@/lib/payments/methods";

/**
 * Texto del estado de una ficha de mesa con cuenta abierta (Mesas del
 * operador y del mesero). Hasta ahora el estado se leía sólo por el color de
 * la ficha y un punto de 8 px: en el datáfono (pantalla de poco gamut) o para
 * quien no distingue bien los colores, «por cobrar» y «en cocina» se veían
 * iguales. Devuelve una clave del namespace `opTables`; null cuando la ficha
 * ya muestra su estado con texto propio (libre, recién pagada).
 */
export type TileStateLabelKey =
  | "tileStateCooking"
  | "tileStateReady"
  | "tileStateEating"
  | "tileStateUnpaid"
  | "tileStateAskedCash"
  | "tileStateAskedTerminal"
  | "tileStateCalledWaiter"
  | "tileStateAskedBill"
  | "tileStateWalkout";

const TERMINAL_METHODS = new Set(["external_terminal", "kushki_card_terminal"]);

export function tileStateLabelKey(
  state: TableVisualState,
  signals: { needsWaiter: boolean; pendingMethods: readonly string[] },
): TileStateLabelKey | null {
  switch (state) {
    case "free":
    case "recently_paid":
      return null;
    case "cooking":
      return "tileStateCooking";
    case "ready_to_serve":
      return "tileStateReady";
    case "eating":
      return "tileStateEating";
    case "eating_at_risk":
      return "tileStateUnpaid";
    case "danger":
      return "tileStateWalkout";
    case "needs_payment":
    case "needs_payment_urgent":
      // Lo más concreto primero: con qué quiere pagar; si sólo llamó.
      if (signals.pendingMethods.some((m) => isCashMethod(m))) return "tileStateAskedCash";
      if (signals.pendingMethods.some((m) => TERMINAL_METHODS.has(m))) return "tileStateAskedTerminal";
      if (signals.needsWaiter && signals.pendingMethods.length === 0) return "tileStateCalledWaiter";
      return "tileStateAskedBill";
  }
}
