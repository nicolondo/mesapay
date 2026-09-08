import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { isValidDiscountPct } from "@/lib/customerDiscount";

const schema = z.object({
  percent: z.number().int(),
  note: z.string().trim().max(120).optional(),
});

/**
 * PUT /api/operator/customers/[id]/discount — activa o cambia el descuento
 * de un comensal EN ESTE restaurante.
 *
 * La llave del upsert es (restaurantId, userId), y el restaurantId sale de
 * la sesión, nunca del body: un restaurante no puede pactar (ni leer) el
 * descuento de otro.
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

  const { id: userId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success || !isValidDiscountPct(parsed.data.percent)) {
    return NextResponse.json({ error: "invalid_percent" }, { status: 400 });
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!user || user.role !== "customer") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await db.customerDiscount.upsert({
    where: {
      restaurantId_userId: { restaurantId: scope.restaurantId, userId },
    },
    create: {
      restaurantId: scope.restaurantId,
      userId,
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

  const { id: userId } = await params;
  await db.customerDiscount.updateMany({
    where: { restaurantId: scope.restaurantId, userId },
    data: { active: false },
  });

  return NextResponse.json({ ok: true });
}
