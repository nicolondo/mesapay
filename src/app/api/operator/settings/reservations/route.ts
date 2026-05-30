import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveReservationConfig } from "@/lib/reservations";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Guarda la config de reservas del restaurante activo:
 *   - enabled: toggle global del módulo
 *   - config:  turnos por día, duración del slot, auto-confirm, etc.
 *
 * El body de config se pasa por resolveReservationConfig() antes de
 * persistir — así normalizamos / descartamos basura y nunca guardamos
 * un blob que después no podamos parsear.
 *
 * Operator / platform_admin only, tenant-scoped.
 */

const shiftSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

const putBody = z.object({
  enabled: z.boolean().optional(),
  config: z
    .object({
      shiftsByDay: z.record(z.string(), z.array(shiftSchema)).optional(),
      slotMinutes: z.number().int().min(30).max(240).optional(),
      autoConfirm: z.boolean().optional(),
      minNoticeHours: z.number().min(0).max(168).optional(),
      maxAdvanceDays: z.number().int().min(1).max(365).optional(),
      policyNote: z.string().max(500).optional(),
    })
    .optional(),
  // Métodos de pago ofrecidos para el DEPÓSITO de reserva. Subconjunto
  // de los online del comercio. Se guarda tal cual; resolveDepositMethods
  // lo intersecta con lo realmente habilitado al leerlo.
  depositMethods: z
    .array(z.enum(["kushki_card", "kushki_pse", "kushki_apple_pay"]))
    .max(3)
    .optional(),
});

export async function PUT(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = putBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const data: {
    reservationsEnabled?: boolean;
    reservationConfig?: object;
    reservationDepositMethods?: string[];
  } = {};
  if (parsed.data.enabled !== undefined) {
    data.reservationsEnabled = parsed.data.enabled;
  }
  if (parsed.data.config !== undefined) {
    // Normalizamos a través del resolver — descarta turnos inválidos,
    // clampea slotMinutes, etc. Guardamos el resultado canónico.
    data.reservationConfig = resolveReservationConfig(parsed.data.config);
  }
  if (parsed.data.depositMethods !== undefined) {
    // Dedupe; resolveDepositMethods filtra contra lo habilitado al leer.
    data.reservationDepositMethods = Array.from(
      new Set(parsed.data.depositMethods),
    );
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  await db.restaurant.update({ where: { id: restaurantId }, data });

  await recordAuditEvent({
    kind: "restaurant.reservations.update",
    restaurantId,
    target: { type: "restaurant", id: restaurantId },
    summary: "Editó configuración de reservas",
    diff: { after: parsed.data },
  });

  return NextResponse.json({ ok: true });
}
