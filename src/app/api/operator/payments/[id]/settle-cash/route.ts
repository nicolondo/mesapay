import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { activateOpenRounds } from "@/lib/prepaidRounds";

const schema = z.object({
  cashReceivedCents: z.number().int().min(0).max(100_000_000),
  changeGivenCents: z.number().int().min(0).max(100_000_000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
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
    const updatedPayment = await tx.payment.update({
      where: { id: payment.id },
      data: {
        amountCents: netReceived,
        status: "approved",
        settledAt: now,
      },
    });

    // Fold the "keep the change" extra into tipCents so it flows to cierre.
    if (extraTipCents > 0) {
      await tx.order.update({
        where: { id: payment.orderId },
        data: {
          tipCents: { increment: extraTipCents },
          totalCents: { increment: extraTipCents },
        },
      });
    }

    const order = await tx.order.findUnique({
      where: { id: payment.orderId },
    });
    if (!order) throw new Error("order vanished");

    const approved = await tx.payment.findMany({
      where: { orderId: order.id, status: "approved" },
    });
    const paidSum = approved.reduce((s, p) => s + p.amountCents, 0);
    const fullyPaid = paidSum >= order.totalCents;

    const finalOrder = await tx.order.update({
      where: { id: order.id },
      data: {
        status: fullyPaid ? "paid" : "paying",
        paidAt: fullyPaid ? (order.paidAt ?? now) : null,
      },
    });

    // Counter-mode prepay rounds stay "open" until cash is settled — release
    // them to the kitchen the moment the operator confirms payment.
    if (fullyPaid) {
      await activateOpenRounds(tx, order.id);
    }

    return { payment: updatedPayment, order: finalOrder, fullyPaid };
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
    paid: result.fullyPaid,
    extraTipCents,
  });
}
