import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  resolveReservationConfig,
  generateConfirmationCode,
} from "@/lib/reservations";
import { sendReservationConfirmation } from "@/lib/reservationEmail";
import { publishOrderEvent } from "@/lib/events";

/**
 * Crea una reserva. Público (lo llama /r/[slug]).
 *
 * El diner manda tableId + startsAt (ISO, lo da el slot de la
 * availability) + datos. Re-validamos server-side:
 *   - el restaurante recibe reservas
 *   - la mesa existe, es reservable y entra el grupo
 *   - el slot sigue libre (anti doble-booking por carrera)
 *
 * endsAt se calcula de startsAt + slotMinutes (no confiamos en el
 * cliente para la duración). status = confirmed o pending según
 * autoConfirm. Mandamos email de confirmación best-effort.
 */
const schema = z.object({
  tableId: z.string().min(1),
  startsAt: z.string().datetime(),
  partySize: z.number().int().min(1).max(20),
  customerName: z.string().trim().min(1).max(80),
  customerEmail: z.string().trim().email().max(160),
  customerPhone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(300).optional(),
  source: z.enum(["direct", "google_maps", "whatsapp", "phone"]).default("direct"),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      reservationsEnabled: true,
      reservationConfig: true,
      legalCity: true,
      logoUrl: true,
    },
  });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }
  if (!tenant.reservationsEnabled) {
    return NextResponse.json(
      { error: "reservations_disabled", message: "Este comercio no recibe reservas." },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const config = resolveReservationConfig(tenant.reservationConfig);
  const startsAt = new Date(parsed.data.startsAt);
  const endsAt = new Date(startsAt.getTime() + config.slotMinutes * 60 * 1000);

  // No reservas en el pasado / fuera de la ventana.
  const now = Date.now();
  if (startsAt.getTime() < now + config.minNoticeHours * 60 * 60 * 1000) {
    return NextResponse.json(
      { error: "too_soon", message: "Ese horario ya no está disponible." },
      { status: 409 },
    );
  }

  // Mesa válida + entra el grupo.
  const table = await db.table.findUnique({
    where: { id: parsed.data.tableId },
    select: {
      id: true,
      restaurantId: true,
      reservable: true,
      capacity: true,
      number: true,
      label: true,
    },
  });
  if (
    !table ||
    table.restaurantId !== tenant.id ||
    !table.reservable ||
    table.number < 0
  ) {
    return NextResponse.json(
      { error: "invalid_table", message: "Mesa no disponible." },
      { status: 400 },
    );
  }
  if (table.capacity < parsed.data.partySize) {
    return NextResponse.json(
      { error: "party_too_big", message: "Esa mesa no alcanza para el grupo." },
      { status: 400 },
    );
  }

  // Anti doble-booking: rechazamos si ya hay una reserva activa que
  // solape la ventana de esta mesa. La unicidad real la garantiza este
  // check dentro de la transacción de creación.
  const reservation = await db.$transaction(async (tx) => {
    const clash = await tx.reservation.findFirst({
      where: {
        tableId: table.id,
        status: { in: ["pending", "confirmed", "seated"] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: { id: true },
    });
    if (clash) {
      throw new Error("SLOT_TAKEN");
    }

    // Confirmation code único — retry si choca (muy improbable).
    let code = generateConfirmationCode();
    for (let i = 0; i < 5; i++) {
      const exists = await tx.reservation.findUnique({
        where: { confirmationCode: code },
        select: { id: true },
      });
      if (!exists) break;
      code = generateConfirmationCode();
    }

    return tx.reservation.create({
      data: {
        restaurantId: tenant.id,
        tableId: table.id,
        customerName: parsed.data.customerName,
        customerEmail: parsed.data.customerEmail,
        customerPhone: parsed.data.customerPhone,
        partySize: parsed.data.partySize,
        startsAt,
        endsAt,
        status: config.autoConfirm ? "confirmed" : "pending",
        source: parsed.data.source,
        notes: parsed.data.notes,
        confirmationCode: code,
      },
    });
  }).catch((err) => {
    if (err instanceof Error && err.message === "SLOT_TAKEN") return null;
    throw err;
  });

  if (!reservation) {
    return NextResponse.json(
      {
        error: "slot_taken",
        message: "Alguien acaba de tomar ese horario. Elegí otro.",
      },
      { status: 409 },
    );
  }

  // Avisar al operador en vivo (la lista de reservas se refresca).
  publishOrderEvent(tenant.id, {
    type: "order.updated",
    orderId: `reservation:${reservation.id}`,
  });

  // Email de confirmación best-effort — no bloquea la respuesta.
  sendReservationConfirmation({
    to: reservation.customerEmail,
    customerName: reservation.customerName,
    restaurantName: tenant.name,
    restaurantCity: tenant.legalCity,
    tableLabel: table.label ?? `Mesa ${table.number}`,
    partySize: reservation.partySize,
    startsAt: reservation.startsAt,
    confirmationCode: reservation.confirmationCode,
    autoConfirmed: config.autoConfirm,
    manageUrl: `${new URL(req.url).origin}/r/${slug}/reserva/${reservation.confirmationCode}`,
  }).catch((err) => console.error("[reservation] email failed", err));

  return NextResponse.json({
    ok: true,
    confirmationCode: reservation.confirmationCode,
    status: reservation.status,
  });
}
