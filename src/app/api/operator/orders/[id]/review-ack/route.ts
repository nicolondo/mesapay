import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { publishOrderEvent } from "@/lib/events";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";

/**
 * POST /api/operator/orders/[id]/review-ack — «Mantener» ante el aviso
 * «Revisar» de la cuenta (src/lib/orderReviewFlags.ts): el personal revisó
 * la mesa y sigue siendo la misma cuenta. Las señales nacidas hasta ahora
 * dejan de avisarse; una señal NUEVA (otra ronda tras horas, otro cobro
 * rechazado) vuelve a avisar. Sólo cuentas vivas del comercio de la sesión.
 */
async function POSTHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await requireOperatorScope();
  if (isScopeError(scope)) {
    return NextResponse.json({ error: scope.error }, { status: scope.error === "forbidden" ? 403 : 400 });
  }
  const { id: orderId } = await params;
  const updated = await db.order.updateMany({
    where: { id: orderId, restaurantId: scope.restaurantId, status: { notIn: ["paid", "cancelled"] } },
    data: { reviewAckAt: new Date() },
  });
  if (updated.count === 0) return NextResponse.json({ error: "not_applicable" }, { status: 409 });
  publishOrderEvent(scope.restaurantId, { type: "order.updated", orderId });
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
