import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAvailability } from "@/lib/reservationAvailability";

/**
 * Disponibilidad de reservas. Público (lo llama la página /r/[slug]).
 *   GET ?date=YYYY-MM-DD&party=N
 * Devuelve los slots del día con mesas libres que entran al grupo.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? "";
  const party = Number(url.searchParams.get("party") ?? "2");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  const partySize = Number.isFinite(party) ? Math.max(1, Math.min(20, party)) : 2;

  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }

  const { slots, floorTables, floorPlan } = await getAvailability({
    restaurantId: tenant.id,
    dateLocal: date,
    partySize,
  });

  return NextResponse.json({
    slots: slots.map((s) => ({
      label: s.label,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      tables: s.tables.map((t) => ({
        id: t.id,
        number: t.number,
        label: t.label,
        capacity: t.capacity,
        minConsumptionCents: t.minConsumptionCents,
        reservationDepositCents: t.reservationDepositCents,
      })),
    })),
    // Mapa del salón (mesas con coords). Vacío si el operador no
    // diseñó el plano — el front cae al picker de lista.
    floorTables,
    // Grilla + zonas + markers (entrada, etc.) para dibujar contexto.
    floorPlan,
  });
}
