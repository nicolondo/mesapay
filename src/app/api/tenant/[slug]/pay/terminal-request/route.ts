import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";

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

  return NextResponse.json({
    paymentId: payment.id,
    pending: true,
  });
}
