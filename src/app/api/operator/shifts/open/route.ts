import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrentShift } from "@/lib/shift";

const schema = z.object({
  // Fondo de caja inicial. Cero es válido (puedes abrir un turno con
  // cero efectivo si el restaurante solo acepta tarjeta hoy).
  // Cap = $100M COP en cents. El cap viejo de 100M cents ($1M COP)
  // se quedaba corto para restaurantes con un turno mediano cash-
  // heavy (un cierre legítimo de $1.013.657 levantó zod "invalid"
  // porque excedía el max por 13k pesos).
  openingCashCents: z.number().int().min(0).max(10_000_000_000),
});

export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // One open shift per restaurant. Closing comes first.
  const existing = await getCurrentShift(restaurantId);
  if (existing) {
    return NextResponse.json(
      { error: "ya hay un turno abierto", shiftId: existing.id },
      { status: 409 },
    );
  }

  const shift = await db.shift.create({
    data: {
      restaurantId,
      openedById: session.user.id,
      openingCashCents: parsed.data.openingCashCents,
    },
  });

  return NextResponse.json({ ok: true, shiftId: shift.id });
}
