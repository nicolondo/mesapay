import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { activateOpenRounds } from "@/lib/prepaidRounds";

const schema = z.object({
  orderId: z.string().min(1),
  method: z.enum(["demo_card", "demo_cash", "demo_nequi"]),
  amountCents: z.number().int().min(100),
  tipCents: z.number().int().min(0).default(0),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return NextResponse.json({ error: "unknown tenant" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const order = await db.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  // Cash runs a different path: the payment stays pending until a waiter
  // settles it in Salón. The order moves to "paying" so it shows up as a
  // pending collection, but we do NOT mark it paid here — pending tips do
  // not touch order.tipCents, that's an approved-only aggregate.
  if (parsed.data.method === "demo_cash") {
    const payment = await db.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          orderId: order.id,
          method: "demo_cash",
          status: "pending",
          amountCents: parsed.data.amountCents,
          tipCents: parsed.data.tipCents,
        },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: order.status === "paid" ? order.status : "paying",
        },
      });
      return p;
    });

    publishOrderEvent(tenant.id, {
      type: "order.cash_requested",
      orderId: order.id,
      paymentId: payment.id,
    });

    return NextResponse.json({
      paymentId: payment.id,
      paid: false,
      pending: true,
    });
  }

  // Demo: approve immediately. demo_nequi rides on wompi_nequi until we wire
  // real Wompi — keeps reports honest about which rail the diner picked.
  const method = parsed.data.method === "demo_nequi" ? "wompi_nequi" : parsed.data.method;

  const result = await db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        method,
        status: "approved",
        amountCents: parsed.data.amountCents,
        tipCents: parsed.data.tipCents,
        settledAt: new Date(),
      },
    });
    // Tips are per-payment: each diner picks their own on their own share.
    // The order-level aggregate is the sum across approved payments; the
    // order is "fully paid" when the food portion (amount − tip) covers the
    // subtotal, regardless of how much anyone tipped.
    const allPayments = await tx.payment.findMany({
      where: { orderId: order.id, status: "approved" },
    });
    const paid = allPayments.reduce((s, p) => s + p.amountCents, 0);
    const tipsTotal = allPayments.reduce((s, p) => s + p.tipCents, 0);
    const foodPaid = paid - tipsTotal;
    const fullyPaid = foodPaid >= order.subtotalCents;
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        tipCents: tipsTotal,
        totalCents: order.subtotalCents + tipsTotal,
        status: fullyPaid ? "paid" : "paying",
        paidAt: fullyPaid ? new Date() : null,
      },
    });
    // Counter-mode prepay: release any open rounds to the kitchen now that
    // the money is in.
    if (fullyPaid) {
      await activateOpenRounds(tx, order.id);
    }
    return { payment, updated, fullyPaid };
  });

  publishOrderEvent(tenant.id, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: order.id,
  });

  if (result.fullyPaid && order.customerId) {
    welcomeIfFirstTime(order.customerId).catch((err) =>
      console.error("[welcomeIfFirstTime]", err),
    );
  }

  return NextResponse.json({
    paymentId: result.payment.id,
    paid: result.fullyPaid,
  });
}
