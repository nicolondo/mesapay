import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { resolveLoginIdentifier } from "@/lib/customerIdentity";
import {
  applyCustomerToOrder,
  findCustomerByIdentifier,
} from "@/lib/customerDiscount";

const schema = z.object({
  identifier: z.string().trim().min(1).max(120),
});

/**
 * POST /api/operator/orders/[id]/identify — el mesero identifica al
 * comensal en la cuenta de la mesa, por cédula o correo.
 *
 * Si esa persona tiene un descuento vigente EN ESTE restaurante, se aplica
 * a la cuenta. El descuento de otro restaurante no se ve ni se aplica: el
 * lookup va contra (restaurantId, userId).
 */
export async function POST(
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

  const customer = await findCustomerByIdentifier(
    ident.kind === "email" ? { email: ident.value } : { cedula: ident.value },
  );
  if (!customer || customer.role !== "customer" || customer.disabledAt) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await applyCustomerToOrder({
    orderId,
    restaurantId: scope.restaurantId,
    userId: customer.id,
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
      id: customer.id,
      name: customer.name,
      email: customer.email,
      cedula: customer.cedula,
    },
    discountPct: result.discountPct,
    discountCents: result.discountCents,
  });
}

/**
 * DELETE — desvincula al comensal de la cuenta y quita el descuento.
 * Caso: el mesero identificó a la persona equivocada.
 */
export async function DELETE(
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
      customerId: null,
      discountPct: null,
      discountCents: 0,
      totalCents: order.subtotalCents,
    },
  });

  publishOrderEvent(scope.restaurantId, { type: "order.updated", orderId });
  return NextResponse.json({ ok: true });
}
