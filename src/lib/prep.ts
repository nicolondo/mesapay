import type { PrepStation } from "@prisma/client";

/**
 * Resolve the effective prep station for a menu item at the moment a
 * round is sent. Item-level override wins over category default; null
 * override means "inherit". We freeze this onto OrderItem.station as a
 * snapshot so re-routing the menu later doesn't yank already-fired
 * tickets between boards mid-service.
 */
export function resolveStation(
  itemPrepStation: PrepStation | null | undefined,
  categoryPrepStation: PrepStation,
): PrepStation {
  return itemPrepStation ?? categoryPrepStation;
}

/**
 * Does this station need someone to actually prepare the item, or is it
 * a grab-and-go from a fridge / shelf?
 *
 *   - counter: always auto-ready (botellitas de agua, gaseosas, cervezas
 *     que solo hay que descorchar al lado de la mesa).
 *   - bar: needs prep IF the restaurant has a bartender. If not, the
 *     drinks fall through to the waiter as grab-from-the-bar.
 *   - kitchen: always needs prep.
 *
 * "Auto-ready" means we set kitchenStatus="ready" at send time and the
 * item shows up directly in the waiter's serve view, skipping all the
 * cocina/bar boards.
 */
export function isAutoReadyStation(
  station: PrepStation,
  hasBar: boolean,
): boolean {
  if (station === "counter") return true;
  if (station === "bar" && !hasBar) return true;
  return false;
}

/**
 * Display label for the station — used as a pill on the waiter's serve
 * board so they know where to pick the item up from.
 */
export function stationLabel(station: PrepStation): string {
  switch (station) {
    case "kitchen":
      return "Cocina";
    case "bar":
      return "Bar";
    case "counter":
      return "Refri";
  }
}
