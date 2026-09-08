import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { removeOrderDiscount } from "@/lib/dinerDiscount";

/**
 * DELETE /api/operator/orders/[id]/discount — el mesero quita el descuento
 * de la cuenta.
 *
 * Deja al comensal identificado: quitar el beneficio (por ejemplo porque
 * no aplica a esta promoción) no es lo mismo que borrar quién es, y
 * perder la identidad rompería el reporte de consumo del cliente.
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
  const ok = await removeOrderDiscount({
    orderId,
    restaurantId: scope.restaurantId,
  });
  if (!ok) {
    return NextResponse.json({ error: "not_applicable" }, { status: 409 });
  }

  // Re-derivar el total sin el descuento.
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { subtotalCents: true, taxCents: true, tipCents: true },
  });
  if (order) {
    await db.order.update({
      where: { id: orderId },
      data: {
        totalCents: order.subtotalCents + order.taxCents + order.tipCents,
      },
    });
  }

  publishOrderEvent(scope.restaurantId, { type: "order.updated", orderId });
  return NextResponse.json({ ok: true });
}
