import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { resolveShiftPolicy } from "@/lib/staffPolicies";
import {
  getCurrentMeseroShift,
} from "@/lib/meseroShift";

/**
 * Abre el turno personal del mesero. Solo permitido cuando el
 * restaurante tiene `shiftPolicy = "by_waiter"`. Idempotente: si
 * ya tiene un turno abierto, devuelve ese.
 *
 * `openingCashCents` queda en 0 — el mesero no tiene caja física
 * propia (el cash drawer lo maneja el operador a nivel restaurante).
 * El campo existe en Shift por requisito del modelo global pero acá
 * no aplica.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "mesero") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const userId = session.user.id;
  const restaurantId = session.user.restaurantId;
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { shiftPolicy: true },
  });
  if (resolveShiftPolicy(tenant?.shiftPolicy) !== "by_waiter") {
    return NextResponse.json(
      {
        error: "shifts_global",
        message:
          "El restaurante maneja un turno único — pídele al operador para abrir.",
      },
      { status: 400 },
    );
  }

  const existing = await getCurrentMeseroShift(userId);
  if (existing) {
    return NextResponse.json({ ok: true, shiftId: existing.id, alreadyOpen: true });
  }

  const shift = await db.shift.create({
    data: {
      restaurantId,
      userId,
      openedById: userId,
      openingCashCents: 0,
      status: "open",
    },
  });

  return NextResponse.json({ ok: true, shiftId: shift.id, alreadyOpen: false });
}
