import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  resolveShiftPolicy,
  resolveMeseroShiftWithoutLocal,
} from "@/lib/staffPolicies";
import {
  getCurrentMeseroShift,
} from "@/lib/meseroShift";
import { getCurrentShift } from "@/lib/shift";
import { publishOrderEvent } from "@/lib/events";

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
    select: { shiftPolicy: true, meseroShiftWithoutLocal: true },
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

  // El turno personal solo tiene sentido dentro de un turno general del
  // local: la base del mesero sale del cajón general y el cierre general
  // los liquida. Si el local no abrió, dos comportamientos configurables:
  //   - "block":     no lo dejamos; el operador debe abrir primero.
  //   - "auto_open": abrimos el turno general con base 0 (y el del mesero
  //                  queda en 0 también, por la regla base_mesero ≤ base_local).
  let localShift = await getCurrentShift(restaurantId);
  let localAutoOpened = false;
  if (!localShift) {
    const fallback = resolveMeseroShiftWithoutLocal(
      tenant?.meseroShiftWithoutLocal,
    );
    if (fallback === "block") {
      return NextResponse.json(
        {
          error: "local_shift_closed",
          message:
            "El local todavía no abrió su turno. Pedile al encargado que abra el turno general; en cuanto lo haga vas a poder abrir el tuyo.",
        },
        { status: 409 },
      );
    }
    localShift = await db.shift.create({
      data: {
        restaurantId,
        openedById: userId,
        openingCashCents: 0,
        status: "open",
      },
    });
    localAutoOpened = true;
  }

  // Regla: la base del mesero nunca puede superar la del local. Si el
  // local arranca en 0 (incl. auto_open), el mesero también arranca en 0.
  // En auto_open forzamos 0 (no rechazamos: queremos que pueda empezar).
  let meseroBase = parsed.data.openingCashCents;
  if (localAutoOpened) {
    meseroBase = 0;
  } else if (meseroBase > localShift.openingCashCents) {
    return NextResponse.json(
      {
        error: "base_exceeds_local",
        maxCents: localShift.openingCashCents,
        message: `Tu base no puede superar la base del local ($${Math.round(
          localShift.openingCashCents / 100,
        ).toLocaleString("es-CO")}).`,
      },
      { status: 409 },
    );
  }

  const shift = await db.shift.create({
    data: {
      restaurantId,
      userId,
      openedById: userId,
      openingCashCents: meseroBase,
      status: "open",
    },
  });

  publishOrderEvent(restaurantId, { type: "cash.updated" });
  return NextResponse.json({
    ok: true,
    shiftId: shift.id,
    alreadyOpen: false,
    localAutoOpened,
  });
}
