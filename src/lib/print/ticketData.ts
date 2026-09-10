/**
 * De una RONDA a una COMANDA.
 *
 * Es la única lectura de la ronda que existe: la consume la pestaña de
 * Chrome (vía /api/operator/print/ticket, que renderiza HTML) y también
 * el encolado para las impresoras de red (que renderiza ESC/POS). Los dos
 * caminos deben imprimir exactamente lo mismo mientras convivan, y eso
 * sólo se garantiza si leen del mismo lado.
 */

import "server-only";
import { db } from "@/lib/db";
import { formatItemSelections } from "@/lib/modifiers";
import type { TicketStation } from "./routing";

export type { TicketStation };

export type RoundTicketItem = {
  qty: number;
  name: string;
  modifiers: string[];
  notes: string | null;
  guestName: string | null;
};

export type RoundTicket = {
  restaurantName: string;
  paperWidthMm: number;
  station: TicketStation;
  barSubStation: string | null;
  roundSeq: number;
  placedAt: Date;
  order: {
    shortCode: string;
    orderType: "dineIn" | "pickup";
    tableNumber: number;
    pickupName: string | null;
    notes: string | null;
    servingMode: "asReady" | "together";
  };
  items: RoundTicketItem[];
};

export type LoadRoundTicketResult =
  | { ok: true; ticket: RoundTicket }
  | { ok: false; reason: "not_found" | "no_items_for_station" | "awaiting_acceptance" };

/**
 * Carga la comanda de una ronda para una estación. `restaurantId` no es
 * opcional: la ronda tiene que pertenecer a ese comercio o no existe.
 */
export async function loadRoundTicket(args: {
  restaurantId: string;
  roundId: string;
  station: TicketStation;
  barSubStation: string | null;
}): Promise<LoadRoundTicketResult> {
  const { restaurantId, roundId, station, barSubStation } = args;
  const round = await db.round.findUnique({
    where: { id: roundId },
    include: {
      order: { include: { table: true, restaurant: true } },
      items: {
        where: {
          station,
          cancelledAt: null,
          ...(station === "bar" && barSubStation
            ? { barSubStation }
            : {}),
        },
        include: { menuItem: { select: { modifiers: true } } },
      },
    },
  });
  if (!round || round.order.restaurantId !== restaurantId) {
    return { ok: false, reason: "not_found" };
  }
  if (
    round.status === "cancelled" ||
    round.order.status === "cancelled" ||
    round.items.length === 0
  ) {
    return { ok: false, reason: "no_items_for_station" };
  }
  // One ticket per station/round: don't freeze the complete order when only
  // its first dish has been accepted. A later rejection must settle first.
  if (round.items.some((item) => item.kitchenStatus === "placed")) {
    return { ok: false, reason: "awaiting_acceptance" };
  }

  return {
    ok: true,
    ticket: {
      restaurantName: round.order.restaurant.name,
      paperWidthMm: round.order.restaurant.printPaperWidthMm,
      station,
      barSubStation,
      roundSeq: round.seq,
      placedAt: round.placedAt,
      order: {
        shortCode: round.order.shortCode,
        orderType: round.order.orderType as "dineIn" | "pickup",
        tableNumber: round.order.table.number,
        pickupName: round.order.pickupName,
        notes: round.order.notes,
        servingMode: round.order.servingMode as "asReady" | "together",
      },
      items: round.items.map((i) => ({
        qty: i.qty,
        name: i.nameSnapshot,
        modifiers: formatItemSelections(
          i.modifierSelections,
          i.menuItem?.modifiers,
        ),
        notes: i.notes,
        guestName: i.guestName,
      })),
    },
  };
}
