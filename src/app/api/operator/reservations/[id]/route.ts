import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";

/**
 * Cambio de estado de una reserva desde el dashboard del operador.
 *   PATCH { status: "confirmed" | "seated" | "completed" | "cancelled" | "no_show" }
 *
 * Operator / mesero / admin (el mesero también gestiona el salón).
 * Tenant-scoped: solo reservas del restaurante activo.
 */
const TRANSITIONS = [
  "confirmed",
  "seated",
  "completed",
  "cancelled",
  "no_show",
] as const;

const body = z.object({ status: z.enum(TRANSITIONS) });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "mesero")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const reservation = await db.reservation.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, status: true },
  });
  if (!reservation || reservation.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.reservation.update({
    where: { id },
    data: { status: parsed.data.status },
  });

  publishOrderEvent(restaurantId, {
    type: "order.updated",
    orderId: `reservation:${id}`,
  });

  return NextResponse.json({ ok: true, status: parsed.data.status });
}
