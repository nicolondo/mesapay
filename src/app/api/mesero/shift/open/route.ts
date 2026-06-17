import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { resolveShiftPolicy } from "@/lib/staffPolicies";
import {
  getCurrentMeseroShift,
} from "@/lib/meseroShift";

const schema = z.object({
  // Base inicial de la caja del mesero — el efectivo con el que
  // arranca para dar vueltos. Cero es válido (no maneja base).
  // Mismo cap que el turno global: $100M COP en cents.
  openingCashCents: z.number().int().min(0).max(10_000_000_000),
});

/**
 * Abre el turno personal del mesero. Solo permitido cuando el
 * restaurante tiene `shiftPolicy = "by_waiter"`. Idempotente: si
 * ya tiene un turno abierto, devuelve ese.
 *
 * El mesero declara su `openingCashCents` (base de su propia caja);
 * al cerrar hace arqueo personal (cuenta el efectivo y se calcula la
 * diferencia contra lo esperado = base + efectivo cobrado).
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "mesero") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const userId = session.user.id;
  const restaurantId = session.user.restaurantId;
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", message: "El monto de la base no es válido." },
      { status: 400 },
    );
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
      openingCashCents: parsed.data.openingCashCents,
      status: "open",
    },
  });

  return NextResponse.json({ ok: true, shiftId: shift.id, alreadyOpen: false });
}
