import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import {
  recomputeOrderTotalsInTx,
  validateNewPaymentAmount,
} from "@/lib/orderTotals";

const schema = z.object({
  orderId: z.string().min(1),
  method: z.enum(["demo_card", "demo_cash", "demo_nequi"]),
  amountCents: z.number().int().min(100),
  tipCents: z.number().int().min(0).default(0),
  // Only meaningful for demo_cash. Ignored otherwise.
  cashTenderCents: z.number().int().min(0).max(100_000_000).optional(),
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

  // Server-side cap: never accept a payment whose food portion would
  // push the bill over the subtotal. Same guardrail in the kushki and
  // terminal routes — see src/lib/orderTotals.ts.
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
          // Optional diner-declared tender so the waiter brings change ready.
          cashTenderCents:
            parsed.data.cashTenderCents != null
              ? parsed.data.cashTenderCents
              : null,
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
    // recomputeOrderTotalsInTx aggregates across approved payments and
    // flips the order to "paid" iff the food portion covers the subtotal.
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    // Counter-mode prepay: release any open rounds to the kitchen now that
    // the money is in.
    if (totals.fullyPaid) {
      await activateOpenRounds(tx, order.id);
    }
    return { payment, fullyPaid: totals.fullyPaid };
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
