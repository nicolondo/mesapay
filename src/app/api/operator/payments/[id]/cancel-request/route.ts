import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { lockOrder } from "@/lib/orderLock";
import { secureApi } from "@/lib/secureApi";
import { isChargeBlocked, chargeBlockedResponse } from "@/lib/chargeGuard";
import { isReplaceablePending } from "@/lib/payments/methods";
import { PendingPaymentInFlightError } from "@/lib/payments/paymentInFlight";
import { terminalClaimedIds } from "@/lib/payments/pendingRequests";
import { toPaymentInFlight } from "@/lib/payments/staffCharge";
import { releaseOrderFromPaying } from "@/lib/payments/orderStatusAfterDecline";

/**
 * "Cancelar solicitud": declina un pago pendiente que es sólo una SOLICITUD
 * (efectivo o datáfono propio pedidos desde el QR, o el datáfono Kushki que
 * todavía no se envió al equipo). No se movió un peso, así que no hay nada
 * que conciliar: la cuenta queda libre para cobrarse de otra forma.
 *
 * Nació con el incidente de Son y Melona (2026-10-31): un
 * `kushki_card_terminal` pendiente sin reclamo `terminal:<id>`, en un
 * comercio sin datáfono registrado, que ninguna pantalla podía resolver.
 *
 * Reglas:
 *   - Mismo control de caja que `settle-external-terminal`: con "solo el
 *     administrador cobra", el mesero no puede (403 charge_admin_only).
 *   - Bajo `lockOrder` se re-lee el pago: si dejó de estar pendiente,
 *     operation_conflict; si ya está EN VUELO (el datáfono Kushki se empujó
 *     al equipo, o cualquier pago en línea), 409 pending_payment_in_flight y
 *     no se toca nada. `terminal/charge` crea su reclamo bajo el mismo lock,
 *     así que no hay carrera: o se cancela antes y el empuje rebota, o se
 *     empujó antes y esto rebota.
 *   - Si la cuenta queda sin pagos pendientes ni aprobados, sale de
 *     `paying` igual que con un rechazo de Kushki.
 *   - Deja rastro en la auditoría (`payment.request_cancelled`).
 */

const ALLOWED_ROLES = new Set(["operator", "platform_admin", "group_admin", "terminal", "mesero"]);

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || !ALLOWED_ROLES.has(session.user.role)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const payment = await db.payment.findUnique({ where: { id }, include: { order: true } });
  if (!payment) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const restaurantId = payment.order.restaurantId;
  if (restaurantId !== (await getActiveRestaurantId())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (await isChargeBlocked(session.user.role, restaurantId)) return chargeBlockedResponse();
  if (payment.status !== "pending") return NextResponse.json({ error: "already_settled" }, { status: 409 });

  const result = await db.$transaction(async (tx) => {
    await lockOrder(tx, payment.orderId);
    const current = await tx.payment.findUniqueOrThrow({ where: { id }, include: { order: true } });
    if (current.status !== "pending") throw new Error("operation_conflict");
    const claimed = await terminalClaimedIds(tx, [current]);
    if (!isReplaceablePending(current, claimed.has(current.id))) {
      // Plata posiblemente en vuelo: se resuelve con el resultado del
      // proveedor o en la conciliación de Pagos, nunca cancelando.
      throw new PendingPaymentInFlightError(toPaymentInFlight(current));
    }
    await tx.payment.update({
      where: { id },
      data: { status: "declined", reconciliationRequired: false },
    });
    const orderStatus = await releaseOrderFromPaying(tx, current.orderId, current.order.status);
    await tx.auditEvent.create({
      data: {
        restaurantId,
        actorUserId: session.user.id,
        actorEmail: session.user.email ?? "",
        actorRole: session.user.role,
        kind: "payment.request_cancelled",
        targetType: "payment",
        targetId: current.id,
        summary: `payment.request_cancelled ${current.method}`,
        diff: {
          before: { status: current.status, orderStatus: current.order.status },
          after: { status: "declined", orderStatus: orderStatus ?? current.order.status },
          method: current.method,
          amountCents: current.amountCents,
          tipCents: current.tipCents,
        },
      },
    });
    return { orderId: current.orderId, orderStatus };
  });

  publishOrderEvent(restaurantId, { type: "order.updated", orderId: result.orderId });
  // La pantalla de espera del comensal (datáfono / efectivo) sale sola al
  // ver el pago declinado; el evento la despierta sin esperar el sondeo.
  publishOrderEvent(restaurantId, {
    type: "payment.declined",
    orderId: result.orderId,
    paymentId: id,
    reason: "request_cancelled",
  });
  return NextResponse.json({ ok: true, status: "declined", orderStatus: result.orderStatus });
}

export const POST = secureApi(POSTHandler);
