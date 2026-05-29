import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";

/**
 * Cancelación pública de reserva por confirmationCode. No requiere
 * login — el código que el diner recibió por email ES la credencial.
 * Sólo permite cancelar reservas activas (pending/confirmed) que no
 * hayan empezado todavía.
 *
 * DELETE /api/tenant/[slug]/reservations/[code]
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string; code: string }> },
) {
  const { slug, code } = await params;

  const reservation = await db.reservation.findUnique({
    where: { confirmationCode: code },
    include: { restaurant: { select: { slug: true, id: true } } },
  });

  if (!reservation || reservation.restaurant.slug !== slug) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Sólo cancelable si sigue activa y no empezó.
  const active =
    reservation.status === "pending" || reservation.status === "confirmed";
  const notStarted = reservation.startsAt.getTime() > Date.now();
  if (!active || !notStarted) {
    return NextResponse.json(
      { error: "not_cancelable", message: "Esta reserva ya no se puede cancelar." },
      { status: 409 },
    );
  }

  await db.reservation.update({
    where: { id: reservation.id },
    data: { status: "cancelled" },
  });

  // Refresca la lista del operador en vivo + libera el slot.
  publishOrderEvent(reservation.restaurant.id, {
    type: "order.updated",
    orderId: `reservation:${reservation.id}`,
  });

  return NextResponse.json({ ok: true });
}
