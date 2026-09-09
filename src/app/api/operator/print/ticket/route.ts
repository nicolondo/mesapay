import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { loadRoundTicket } from "@/lib/print/ticketData";

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
  // Kitchen / bar también imprimen — sus pantallas (/cocina, /bar)
  // re-exportan los boards del operador y la auto-impresión dispara
  // este GET cada vez que un round nuevo entra a la estación. Sin
  // estos roles acá la impresión falla en silencio.
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "kitchen" &&
      session.user.role !== "bar")
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

  // La lectura de la ronda vive en @/lib/print/ticketData porque la
  // comparte con el encolado ESC/POS: mientras la pestaña y las
  // impresoras de red convivan, tienen que imprimir exactamente lo mismo.
  const loaded = await loadRoundTicket({
    restaurantId,
    roundId,
    station,
    barSubStation: sub,
  });
  if (!loaded.ok) {
    return NextResponse.json({ error: loaded.reason }, { status: 404 });
  }

  return NextResponse.json({
    ...loaded.ticket,
    placedAt: loaded.ticket.placedAt.toISOString(),
  });
}
