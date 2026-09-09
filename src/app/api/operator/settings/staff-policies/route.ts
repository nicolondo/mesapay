import { secureApi } from "@/lib/secureApi";
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
import { shiftPolicyAllowedWith } from "@/lib/chargeControl";

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
  // Gastos de representación: permitir cerrar cuentas como cortesía ($0) +
  // nombre configurable. compLabel vacío ⇒ null (usa el default de i18n).
  compEnabled: z.boolean().optional(),
  compLabel: z.string().trim().max(40).optional(),
  // Control de caja: sólo el administrador inicia el cobro. Implica
  // shiftPolicy = "global" (ver abajo).
  adminOnlyCharge: z.boolean().optional(),
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
async function PUTHandler(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin" && session.user.role !== "group_admin")
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
      compEnabled: true,
      compLabel: true,
      adminOnlyCharge: true,
    },
  });

  // ── Control de caja: coherencia con la política de turnos ──────────────
  //
  // "Solo el administrador cobra" implica turno ÚNICO DEL LOCAL: si nadie
  // más que el dueño toca la plata, un turno por mesero no tiene contra qué
  // cuadrar (ningún cobro queda atado a un mesero, su arqueo daría siempre
  // $0). Estado resultante del PUT = lo que mande el cliente, o lo guardado.
  const nextAdminOnlyCharge =
    parsed.data.adminOnlyCharge ?? before?.adminOnlyCharge ?? false;

  // Rechazamos la combinación contradictoria en vez de "arreglarla" en
  // silencio: si el dueño eligió turno por mesero queremos que vea por qué
  // no se aplicó, no que se le cambie a la espalda.
  if (
    parsed.data.shiftPolicy === "by_waiter" &&
    !shiftPolicyAllowedWith("by_waiter", nextAdminOnlyCharge)
  ) {
    return NextResponse.json(
      { error: "shift_policy_locked_by_admin_charge" },
      { status: 409 },
    );
  }

  // Transición peligrosa: encender el control con turnos de MESERO
  // abiertos. Cerrarlos a la fuerza descuadraría el arqueo (nadie declaró
  // el efectivo que tienen en el bolsillo) y dejarlos vivos en modo
  // "global" los volvería huérfanos: no aparecen en el cierre del local ni
  // se los puede cerrar desde la PWA, porque la política ya no es
  // by_waiter. La salida defendible es NO dejar encender hasta que cada
  // mesero cierre el suyo con su plata en la mano.
  const turningOn =
    parsed.data.adminOnlyCharge === true && before?.adminOnlyCharge !== true;
  if (turningOn) {
    const openMeseroShifts = await db.shift.count({
      where: { restaurantId, status: "open", userId: { not: null } },
    });
    if (openMeseroShifts > 0) {
      return NextResponse.json(
        { error: "open_mesero_shifts", count: openMeseroShifts },
        { status: 409 },
      );
    }
  }

  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      ...(parsed.data.tipPolicy !== undefined && {
        tipPolicy: parsed.data.tipPolicy,
      }),
      // Con el control de caja activo la política queda clavada en
      // "global", venga o no shiftPolicy en el body. Así el dato en base
      // es coherente y ningún lector (cierre, arqueo, PWA del mesero)
      // tiene que acordarse de resolver la implicación.
      ...(nextAdminOnlyCharge
        ? { shiftPolicy: "global" }
        : parsed.data.shiftPolicy !== undefined && {
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
      ...(parsed.data.compEnabled !== undefined && {
        compEnabled: parsed.data.compEnabled,
      }),
      ...(parsed.data.compLabel !== undefined && {
        compLabel: parsed.data.compLabel || null,
      }),
      ...(parsed.data.adminOnlyCharge !== undefined && {
        adminOnlyCharge: parsed.data.adminOnlyCharge,
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

export const PUT = secureApi(PUTHandler);
