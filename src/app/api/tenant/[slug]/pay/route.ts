import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";

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

  // Demo: approve immediately. Map demo_nequi → wompi_nequi later when real Wompi wired.
  const method = parsed.data.method === "demo_nequi" ? "demo_card" : parsed.data.method;

  const result = await db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        method,
        status: "approved",
        amountCents: parsed.data.amountCents,
        settledAt: new Date(),
      },
    });
    const allPayments = await tx.payment.findMany({
      where: { orderId: order.id, status: "approved" },
    });
    const paid = allPayments.reduce((s, p) => s + p.amountCents, 0);
    const expected = order.subtotalCents + parsed.data.tipCents;
    const fullyPaid = paid >= expected;
    const updated = await tx.order.update({
      where: { id: order.id },
      data: {
        tipCents: parsed.data.tipCents,
        totalCents: expected,
        status: fullyPaid ? "paid" : "paying",
        paidAt: fullyPaid ? new Date() : null,
      },
    });
    return { payment, updated, fullyPaid };
  });

  publishOrderEvent(tenant.id, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: order.id,
  });

  return NextResponse.json({
    paymentId: result.payment.id,
    paid: result.fullyPaid,
  });
}
