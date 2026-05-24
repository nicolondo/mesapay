import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { flattenSelections } from "@/lib/modifiers";

/**
 * Return the data needed to print a single ticket. The print listener
 * page calls this when it receives a "ticket.printable" SSE event,
 * then renders the response into an iframe and triggers print().
 *
 * Query params:
 *   roundId       — which round to print
 *   station       — "kitchen" | "bar" (filters items)
 *   barSubStation — optional, when restaurant has sub-stations
 *
 * Output is shaped for browser-side rendering. The print stylesheet
 * lives on the listener page and handles `@page` sizing for the
 * configured paper width.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const url = new URL(req.url);
  const roundId = url.searchParams.get("roundId");
  const station = url.searchParams.get("station");
  const sub = url.searchParams.get("barSubStation");
  if (!roundId || (station !== "kitchen" && station !== "bar")) {
    return NextResponse.json({ error: "invalid_params" }, { status: 400 });
  }

  const round = await db.round.findUnique({
    where: { id: roundId },
    include: {
      order: { include: { table: true, restaurant: true } },
      items: {
        where: {
          station,
          ...(station === "bar" && sub ? { barSubStation: sub } : {}),
        },
      },
    },
  });
  if (!round || round.order.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (round.items.length === 0) {
    return NextResponse.json({ error: "no_items_for_station" }, { status: 404 });
  }

  return NextResponse.json({
    restaurantName: round.order.restaurant.name,
    paperWidthMm: round.order.restaurant.printPaperWidthMm,
    station,
    barSubStation: sub,
    roundSeq: round.seq,
    placedAt: round.placedAt.toISOString(),
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
      modifiers: flattenSelections(i.modifierSelections),
      notes: i.notes,
      guestName: i.guestName,
    })),
  });
}
