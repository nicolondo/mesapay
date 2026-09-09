import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { issueRequestedInvoiceOnPaid } from "@/lib/invoiceOnPaid";
import { meseroNeedsShiftToCharge } from "@/lib/meseroShift";
import { isChargeBlocked, chargeBlockedResponse } from "@/lib/chargeGuard";

const schema = z.object({
  cashReceivedCents: z.number().int().min(0).max(100_000_000),
  changeGivenCents: z.number().int().min(0).max(100_000_000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  // Quién settle cash:
  //   - operator/platform_admin: gestión general.
  //   - terminal: el cajero del datáfono también cobra efectivo en algunas
  //     configuraciones.
  //   - mesero: cuando un cliente pidió cobrar en efectivo desde el QR,
  //     el mesero confirma físicamente (recibido + vuelta) desde Salón.
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
  if (payment.method !== "demo_cash") {
    return NextResponse.json({ error: "not a cash payment" }, { status: 400 });
  }
  // Control de caja: recibir la plata y cerrar el pago es el momento del
  // cobro. Con "solo el administrador cobra" el mesero no puede confirmar
  // el efectivo — aunque el pending lo haya creado el comensal desde el QR.
  if (await isChargeBlocked(session.user.role, payment.order.restaurantId)) {
    return chargeBlockedResponse();
  }
  // En by_waiter el mesero no puede cobrar sin turno propio abierto.
  if (
    await meseroNeedsShiftToCharge(
      session.user.id,
      session.user.role,
      payment.order.restaurantId,
    )
  ) {
    return NextResponse.json(
      {
        error: "mesero_no_shift",
        message: "No tenés turno abierto. Abrí tu turno para cobrar.",
      },
      { status: 409 },
    );
  }
  if (payment.status !== "pending") {
    return NextResponse.json({ error: "already settled" }, { status: 409 });
  }

  const { cashReceivedCents, changeGivenCents } = parsed.data;
  const netReceived = cashReceivedCents - changeGivenCents;

  if (netReceived < payment.amountCents) {
    return NextResponse.json(
      { error: "recibido insuficiente" },
      { status: 400 },
    );
  }
  if (changeGivenCents > cashReceivedCents) {
    return NextResponse.json(
      { error: "devuelta mayor al recibido" },
      { status: 400 },
    );
  }

  const extraTipCents = netReceived - payment.amountCents;

  const result = await db.$transaction(async (tx) => {
    const now = new Date();
    // "Keep the change" tips land on this specific payment so the per-payment
    // tip stays coherent with the ledger.
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        amountCents: netReceived,
        tipCents: payment.tipCents + extraTipCents,
        status: "approved",
        settledAt: now,
        // Solo sobreescribimos collectedByUserId si la fila no tenía
        // uno asignado todavía (caso: cliente solicitó cobro desde
        // su QR con method=demo_cash, mesero llega después y settlea
        // — el mesero pasa a ser el cobrador). Si ya estaba seteado
        // (otro mesero le pasó la cuenta y este la cierra) lo
        // respetamos.
        collectedByUserId: payment.collectedByUserId ?? session.user.id,
      },
    });

    const totals = await recomputeOrderTotalsInTx(tx, payment.orderId);

    // Counter-mode prepay rounds stay "open" until cash is settled — release
    // them to the kitchen the moment the operator confirms payment.
    if (totals.fullyPaid) {
      await activateOpenRounds(tx, payment.orderId);
    }

    return { payment: updatedPayment, fullyPaid: totals.fullyPaid };
  });

  publishOrderEvent(payment.order.restaurantId, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: payment.orderId,
  });

  if (result.fullyPaid && payment.order.dinerId) {
    welcomeIfFirstTime(payment.order.dinerId, payment.order.locale).catch((err) =>
      console.error("[welcomeIfFirstTime]", err),
    );
  }

  // La cuenta quedó cerrada: si el comensal pidió factura en el checkout, se
  // emite y se envía ahora. Fuera de la transacción y a prueba de fallos.
  if (result.fullyPaid) {
    await issueRequestedInvoiceOnPaid({
      tenantId: payment.order.restaurantId,
      orderId: payment.orderId,
    });
  }

  return NextResponse.json({
    ok: true,
    paid: result.fullyPaid,
    extraTipCents,
  });
}
