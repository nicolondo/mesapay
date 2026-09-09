import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
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
  const ok = await removeOrderDiscount({
    orderId,
    restaurantId: scope.restaurantId,
  });
  if (!ok) {
    return NextResponse.json({ error: "not_applicable" }, { status: 409 });
  }

  publishOrderEvent(scope.restaurantId, { type: "order.updated", orderId });
  return NextResponse.json({ ok: true });
}

export const DELETE = secureApi(DELETEHandler);
