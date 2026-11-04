import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { terminalClaimKey } from "@/lib/payments/methods";
import { TERMINAL_CANCELED_REASON, toTerminalAttemptView } from "@/lib/payments/terminalAttempt";
import { COLLECTOR_ROLES, staffForRestaurant } from "@/lib/staffAccess";

async function GETHandler(
  _req: Request,
  { params }: { params: Promise<{ slug: string; paymentId: string }> },
) {
  const { slug, paymentId } = await params;
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: { order: { include: { restaurant: true } } },
  });
  if (!payment || payment.order.restaurant.slug !== slug) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Datáfono Kushki: el reclamo `terminal:<id>` dice qué pasó con el envío.
  //   - Declinado porque se canceló en el equipo (o el staff cerró el intento
  //     que el equipo no aprobó): `declineReason`, para que la pantalla del
  //     comensal no diga "Pago rechazado".
  //   - Reintentado: `nextPaymentId`, para que la pantalla siga al pago nuevo.
  //   - Pendiente y quien mira es del equipo: `terminalAttempt`, para ofrecer
  //     reintentar / cancelar en la pantalla de espera del staff.
  const claim =
    payment.method === "kushki_card_terminal" && payment.status !== "approved"
      ? await db.financialOperation.findUnique({ where: { key: terminalClaimKey(payment.id) } })
      : null;
  const declined = payment.status === "declined";
  const staff =
    claim && payment.status === "pending"
      ? await staffForRestaurant(payment.order.restaurantId, COLLECTOR_ROLES)
      : null;
  return NextResponse.json({
    id: payment.id,
    status: payment.status,
    amountCents: payment.amountCents,
    orderStatus: payment.order.status,
    ...(declined && claim?.answeredAt ? { declineReason: TERMINAL_CANCELED_REASON } : {}),
    ...(declined && claim?.nextPaymentId ? { nextPaymentId: claim.nextPaymentId } : {}),
    ...(staff ? { terminalAttempt: toTerminalAttemptView(claim, payment.reconciliationRequired) } : {}),
  });
}

export const GET = secureApi(GETHandler);
