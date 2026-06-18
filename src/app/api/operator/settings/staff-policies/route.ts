import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  TIP_POLICIES,
  SHIFT_POLICIES,
  MESERO_SHIFT_WITHOUT_LOCAL,
} from "@/lib/staffPolicies";
import { recordAuditEvent } from "@/lib/auditLog";

const putBody = z.object({
  tipPolicy: z.enum(TIP_POLICIES).optional(),
  shiftPolicy: z.enum(SHIFT_POLICIES).optional(),
  // Umbral en minutos para walkout-risk en Mesas. Acepta 1-180 —
  // <1 sería absurdo, >180 (3h) sería ignorar el feature. Default 20.
  walkoutDangerMinutes: z.number().int().min(1).max(180).optional(),
  // Hora de corte del día contable (0-23). Un comercio que cierra a las
  // 2-3am pone 5 para que la madrugada cuente para la jornada anterior.
  businessDayCutoffHour: z.number().int().min(0).max(23).optional(),
  // Qué hacer si el mesero abre turno sin que el local abriera el suyo.
  meseroShiftWithoutLocal: z.enum(MESERO_SHIFT_WITHOUT_LOCAL).optional(),
});

/**
 * Actualiza las dos políticas del staff del restaurante activo:
 *   - tipPolicy:   "shared" vs "by_waiter"
 *   - shiftPolicy: "global" vs "by_waiter"
 *
 * Tenant-scoped + operator/admin only. Aceptamos PUT con cualquiera de
 * las dos llaves (o ambas) — el cliente puede actualizar una sola sin
 * mandar la otra.
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
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

  // Snapshot del estado antes para el audit log.
  const before = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      tipPolicy: true,
      shiftPolicy: true,
      walkoutDangerMinutes: true,
      businessDayCutoffHour: true,
      meseroShiftWithoutLocal: true,
    },
  });

  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      ...(parsed.data.tipPolicy !== undefined && {
        tipPolicy: parsed.data.tipPolicy,
      }),
      ...(parsed.data.shiftPolicy !== undefined && {
        shiftPolicy: parsed.data.shiftPolicy,
      }),
      ...(parsed.data.walkoutDangerMinutes !== undefined && {
        walkoutDangerMinutes: parsed.data.walkoutDangerMinutes,
      }),
      ...(parsed.data.businessDayCutoffHour !== undefined && {
        businessDayCutoffHour: parsed.data.businessDayCutoffHour,
      }),
      ...(parsed.data.meseroShiftWithoutLocal !== undefined && {
        meseroShiftWithoutLocal: parsed.data.meseroShiftWithoutLocal,
      }),
    },
  });

  await recordAuditEvent({
    kind: "restaurant.staff_policies.update",
    restaurantId,
    target: { type: "restaurant", id: restaurantId },
    summary: "Editó políticas de staff",
    diff: { before: before ?? {}, after: parsed.data },
  });

  return NextResponse.json({ ok: true });
}
