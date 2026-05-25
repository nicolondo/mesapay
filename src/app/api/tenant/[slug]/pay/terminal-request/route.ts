import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { validateNewPaymentAmount } from "@/lib/orderTotals";
import { sendPushToMeserosForTable } from "@/lib/push";

/**
 * "Tarjeta con datáfono" — the diner taps this and we create a pending
 * Payment row with method=kushki_card_terminal. The terminal grid surfaces
 * it and a server can push the amount to the actual terminal.
 *
 * No call to Kushki here. That happens when the terminal operator clicks
 * "Cobrar" on the table — see /api/tenant/[slug]/terminal/charge.
 */

const schema = z.object({
  orderId: z.string().min(1),
  amountCents: z.number().int().min(100),
  tipCents: z.number().int().min(0).default(0),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const order = await db.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  // Cap before queuing the datáfono push — same outstanding check we
  // use for the other rails. A pending kushki_card_terminal payment
  // also counts toward "claimed" money so we won't push two
  // simultaneous datáfono requests for the same outstanding amount.
  const foodPortion = parsed.data.amountCents - parsed.data.tipCents;
  const cap = await validateNewPaymentAmount(order.id, foodPortion);
  if (!cap.ok) {
    return NextResponse.json(
      {
        error: cap.reason,
        outstandingCents: cap.outstandingCents,
        message:
          cap.reason === "order_already_paid"
            ? "Esta cuenta ya fue pagada."
            : `Quedan $${(cap.outstandingCents / 100).toLocaleString("es-CO")} pendientes — intenta de nuevo con un monto menor.`,
      },
      { status: 409 },
    );
  }

  const payment = await db.$transaction(async (tx) => {
    const p = await tx.payment.create({
      data: {
        orderId: order.id,
        method: "kushki_card_terminal",
        status: "pending",
        amountCents: parsed.data.amountCents,
        tipCents: parsed.data.tipCents,
      },
    });
    await tx.order.update({
      where: { id: order.id },
      data: { status: order.status === "paid" ? order.status : "paying" },
    });
    return p;
  });

  publishOrderEvent(tenant.id, {
    type: "order.terminal_requested",
    orderId: order.id,
    paymentId: payment.id,
    amountCents: parsed.data.amountCents + parsed.data.tipCents,
  });

  // Native push to meseros assigned to this table.
  void (async () => {
    const table = order.tableId
      ? await db.table.findUnique({
          where: { id: order.tableId },
          select: { number: true, label: true },
        })
      : null;
    if (!table || table.number < 0) return;
    const where = table.label ?? `Mesa ${table.number}`;
    const totalCop = (parsed.data.amountCents + parsed.data.tipCents) / 100;
    await sendPushToMeserosForTable(tenant.id, table.number, {
      title: `${where} pidió datáfono`,
      body: `Cobro con tarjeta · ${totalCop.toLocaleString("es-CO")} COP`,
      tag: `terminal-${order.id}`,
      url: "/mesero/salon",
    });
  })().catch((err) => console.error("[push:terminal]", err));

  return NextResponse.json({
    paymentId: payment.id,
    pending: true,
  });
}
