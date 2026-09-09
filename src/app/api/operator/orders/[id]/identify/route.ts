import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { resolveLoginIdentifier } from "@/lib/customerIdentity";
import { applyDinerToOrder, findDinerByIdentifier } from "@/lib/dinerDiscount";

const schema = z.object({
  identifier: z.string().trim().min(1).max(120),
});

/**
 * POST /api/operator/orders/[id]/identify — el mesero identifica al
 * comensal en la cuenta de la mesa, por cédula o correo.
 *
 * Solo encuentra comensales DE ESTE comercio: desde que el registro es por
 * restaurante, la base de comensales de cada local es suya. Si la persona
 * no tiene cuenta acá, la respuesta es "no encontrado" y tiene que
 * registrarse — aunque coma en otro MESAPAY.
 *
 * Si esa persona tiene un descuento vigente, se aplica a la cuenta.
 */
async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await requireOperatorScope();
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }

  const { id: orderId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const ident = resolveLoginIdentifier(parsed.data.identifier);
  if (ident.kind === "invalid") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const diner = await findDinerByIdentifier({
    restaurantId: scope.restaurantId,
    ...(ident.kind === "email"
      ? { email: ident.value }
      : { cedula: ident.value }),
  });
  if (!diner || diner.disabledAt) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await applyDinerToOrder({
    orderId,
    restaurantId: scope.restaurantId,
    dinerId: diner.id,
  });
  if (!result) {
    // La orden no existe, es de otro restaurante, o ya está pagada.
    return NextResponse.json({ error: "not_applicable" }, { status: 409 });
  }

  // El subtotal ya está guardado con el descuento; se avisa a las vistas
  // vivas (salón, mesas, pantalla del comensal) para que lo refresquen.
  publishOrderEvent(scope.restaurantId, { type: "order.updated", orderId });

  return NextResponse.json({
    ok: true,
    customer: {
      id: diner.id,
      name: diner.name,
      email: diner.email,
      cedula: diner.cedula,
    },
    discountPct: result.discountPct,
    discountCents: result.discountCents,
  });
}

/**
 * DELETE — desvincula al comensal de la cuenta y quita el descuento.
 * Caso: el mesero identificó a la persona equivocada.
 */
async function DELETEHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await requireOperatorScope();
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }
  const { id: orderId } = await params;

  const order = await db.order.findFirst({
    where: {
      id: orderId,
      restaurantId: scope.restaurantId,
      status: { not: "paid" },
    },
    select: { id: true, subtotalCents: true },
  });
  if (!order) {
    return NextResponse.json({ error: "not_applicable" }, { status: 409 });
  }

  await db.order.update({
    where: { id: order.id },
    data: {
      dinerId: null,
      discountPct: null,
      discountCents: 0,
      totalCents: order.subtotalCents,
    },
  });

  publishOrderEvent(scope.restaurantId, { type: "order.updated", orderId });
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
export const DELETE = secureApi(DELETEHandler);
