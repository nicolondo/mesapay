import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { isValidDiscountPct } from "@/lib/dinerDiscount";

const schema = z.object({
  percent: z.number().int(),
  note: z.string().trim().max(120).optional(),
});

/**
 * PUT /api/operator/diners/[id]/discount — activa o cambia el descuento de
 * un comensal de ESTE restaurante.
 *
 * Antes la llave era (restaurantId, userId) porque la identidad del
 * comensal era global; ahora el descuento cuelga del comensal y el comensal
 * de un solo comercio. Lo que se conserva es la verificación de que ese
 * comensal SEA de este restaurante — el id llega por la URL, así que sin
 * ese chequeo un operador podría pactarle (y leerle) un descuento a un
 * comensal ajeno. El restaurantId sale de la sesión, nunca del body.
 *
 * Solo operator / admin: el mesero puede QUITAR el descuento de una cuenta
 * puntual, pero no pactar uno nuevo — eso es una decisión comercial.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await requireOperatorScope([
    "operator",
    "platform_admin",
    "group_admin",
  ]);
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }

  const { id: dinerId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success || !isValidDiscountPct(parsed.data.percent)) {
    return NextResponse.json({ error: "invalid_percent" }, { status: 400 });
  }

  const diner = await db.diner.findUnique({
    where: { id: dinerId },
    select: { id: true, restaurantId: true },
  });
  if (!diner || diner.restaurantId !== scope.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.dinerDiscount.upsert({
    where: { dinerId },
    create: {
      dinerId,
      percent: parsed.data.percent,
      note: parsed.data.note,
      active: true,
    },
    update: {
      percent: parsed.data.percent,
      note: parsed.data.note,
      active: true,
    },
  });

  return NextResponse.json({ ok: true });
}

/**
 * DELETE — apaga el descuento (active=false) en vez de borrar la fila:
 * prender y apagar un descuento es una operación comercial normal y el
 * historial de cuándo se pactó importa para auditar cuentas viejas.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await requireOperatorScope([
    "operator",
    "platform_admin",
    "group_admin",
  ]);
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }

  const { id: dinerId } = await params;
  // El `diner.restaurantId` en el where es lo que impide apagar el descuento
  // que otro local le pactó a un comensal suyo.
  await db.dinerDiscount.updateMany({
    where: { dinerId, diner: { restaurantId: scope.restaurantId } },
    data: { active: false },
  });

  return NextResponse.json({ ok: true });
}
