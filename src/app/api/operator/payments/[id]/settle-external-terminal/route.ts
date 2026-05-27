import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";

/**
 * Settle de un cobro vía datáfono propio del comercio
 * (method=external_terminal). El mesero pasa la tarjeta por su POS
 * físico (Bancolombia, Davivienda, etc.) y reporta acá si quedó
 * aprobado o rechazado.
 *
 * No hay integración con el adquiriente — MESAPAY confía en lo que
 * el mesero declara, igual que con efectivo. Si el datáfono externo
 * rechazó, el mesero marca decline y el outstanding del order queda
 * intacto para reintentar con otro método.
 *
 * Diseño: action: "approve" | "decline" como simple discriminator
 * en el body. No aceptamos modificar el monto cobrado — el datáfono
 * externo siempre cobra el monto del Payment original; si la
 * propina cambió en el momento, el mesero puede cancelar este pago
 * y crear uno nuevo con el monto correcto.
 */
const schema = z.object({
  action: z.enum(["approve", "decline"]),
  // Razón opcional cuando declina (UI puede mostrarlo después).
  declineReason: z.string().trim().max(120).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "terminal" &&
      session.user.role !== "mesero")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const payment = await db.payment.findUnique({
    where: { id },
    include: { order: true },
  });
  if (!payment) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const activeId = await getActiveRestaurantId();
  if (payment.order.restaurantId !== activeId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (payment.method !== "external_terminal") {
    return NextResponse.json(
      { error: "not an external_terminal payment" },
      { status: 400 },
    );
  }
  if (payment.status !== "pending") {
    return NextResponse.json({ error: "already settled" }, { status: 409 });
  }

  // Decline path — flag como rechazado, deja el order disponible
  // para reintentar con otro método.
  if (parsed.data.action === "decline") {
    await db.payment.update({
      where: { id: payment.id },
      data: {
        status: "declined",
        // Guardamos la razón en el campo libre que tiene Payment
        // (si existe), o en raw — por ahora dejamos vacío y la UI
        // muestra "Rechazado" sin más detalle. Iteramos después si
        // hace falta tracking más fino.
      },
    });
    publishOrderEvent(payment.order.restaurantId, {
      type: "order.updated",
      orderId: payment.orderId,
    });
    return NextResponse.json({ ok: true, status: "declined" });
  }

  // Approve path — marca como pagado, recompute totals, activa
  // rounds si correspondía y emite el evento de paid.
  const result = await db.$transaction(async (tx) => {
    const now = new Date();
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "approved",
        settledAt: now,
        // Si el pending nació sin collectedByUserId (caso típico:
        // diner tocó el botón desde su QR), el mesero que settlea
        // pasa a ser el cobrador para reportes de propinas.
        collectedByUserId: payment.collectedByUserId ?? session.user.id,
      },
    });
    const totals = await recomputeOrderTotalsInTx(tx, payment.orderId);
    if (totals.fullyPaid) {
      await activateOpenRounds(tx, payment.orderId);
    }
    return { payment: updated, fullyPaid: totals.fullyPaid };
  });

  publishOrderEvent(payment.order.restaurantId, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: payment.orderId,
  });

  if (result.fullyPaid && payment.order.customerId) {
    welcomeIfFirstTime(payment.order.customerId).catch((err) =>
      console.error("[welcomeIfFirstTime]", err),
    );
  }

  return NextResponse.json({
    ok: true,
    status: "approved",
    paid: result.fullyPaid,
  });
}
