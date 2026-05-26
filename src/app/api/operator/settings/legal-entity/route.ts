import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Asigna (o desasigna) la razón social del grupo a este restaurante.
 * Cuando hay legalEntityId seteado, las facturas del restaurante
 * heredan los datos legales + numeración DIAN del LegalEntity.
 * Cuando es null, el restaurante usa sus propios campos legal* de
 * la tabla Restaurant (legacy/fallback).
 *
 * Quién puede: operator (de este restaurante), group_admin
 * impersonando, platform_admin impersonando. Validación de scope:
 * el LegalEntity (si se pasa) debe ser del mismo grupo que el
 * restaurante.
 */
const bodySchema = z.object({
  legalEntityId: z.string().nullable(),
});

export async function PUT(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "group_admin")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const rest = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, groupId: true, legalEntityId: true, name: true },
  });
  if (!rest) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Si se está asignando un LegalEntity, validar que pertenezca al
  // mismo grupo del restaurante. Sin grupo no se puede asignar.
  if (parsed.data.legalEntityId) {
    if (!rest.groupId) {
      return NextResponse.json(
        {
          error: "no_group",
          message:
            "El restaurante no pertenece a un grupo. No puede usar razones sociales del grupo.",
        },
        { status: 400 },
      );
    }
    const entity = await db.legalEntity.findUnique({
      where: { id: parsed.data.legalEntityId },
      select: { groupId: true },
    });
    if (!entity || entity.groupId !== rest.groupId) {
      return NextResponse.json(
        { error: "invalid", message: "Razón social no encontrada" },
        { status: 404 },
      );
    }
  }

  await db.restaurant.update({
    where: { id: rest.id },
    data: { legalEntityId: parsed.data.legalEntityId },
  });

  await recordAuditEvent({
    kind: "restaurant.identity.update",
    restaurantId: rest.id,
    target: { type: "restaurant", id: rest.id },
    summary: parsed.data.legalEntityId
      ? `Asignó razón social del grupo a ${rest.name}`
      : `Desasignó razón social del grupo en ${rest.name}`,
    diff: {
      before: { legalEntityId: rest.legalEntityId },
      after: { legalEntityId: parsed.data.legalEntityId },
    },
  });

  return NextResponse.json({ ok: true });
}
