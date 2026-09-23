import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { enqueuePrebillTicket } from "@/lib/print/prebillQueue";

/**
 * POST /api/operator/orders/[id]/prebill — manda la PRECUENTA de una
 * cuenta abierta a la impresora de facturas del local.
 *
 * La precuenta es el papel que el mesero lleva a la mesa antes de cobrar:
 * detalle del consumo y total pendiente, con la leyenda "no es una
 * factura". La factura (y la electrónica) sale recién al cobrar, por el
 * camino de siempre — esto no numera ni congela nada.
 *
 * Quién puede: el mismo staff que confirma un efectivo desde Salón
 * (`settle-cash`): operador, admins y el MESERO, que es quien de hecho la
 * lleva a la mesa. `requireOperatorScope` ya lo incluye.
 *
 * Responde `{ queued, reason?, printerName? }` y NUNCA falla por "no hay
 * impresora": en ese caso `queued: false` y el cliente abre la vista
 * imprimible del navegador (`/operator/orders/[id]/precuenta`).
 */
async function POSTHandler(
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
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, restaurantId: true, status: true, shortCode: true },
  });
  if (!order) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (order.restaurantId !== scope.restaurantId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Ya pagada o cancelada: lo que corresponde es la factura, no esto.
  if (order.status === "paid" || order.status === "cancelled") {
    return NextResponse.json({ error: "order_closed" }, { status: 409 });
  }

  const result = await enqueuePrebillTicket({
    restaurantId: scope.restaurantId,
    orderId: order.id,
    requestedByUserId: scope.userId,
  });

  if (!result.queued && result.reason === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!result.queued && result.reason === "order_closed") {
    return NextResponse.json({ error: "order_closed" }, { status: 409 });
  }

  // Queda rastro las dos veces: por impresora o por el navegador. Es lo
  // que contesta "¿quién le llevó la cuenta a la mesa 7 y cuándo?".
  await recordAuditEvent({
    kind: "order.prebill.print",
    restaurantId: scope.restaurantId,
    target: { type: "order", id: order.id },
    summary: result.queued
      ? `Imprimió precuenta ${order.shortCode} en ${result.printerName}`
      : `Abrió precuenta ${order.shortCode} para imprimir desde el navegador (${result.reason})`,
  });

  return NextResponse.json(result);
}

export const POST = secureApi(POSTHandler);
