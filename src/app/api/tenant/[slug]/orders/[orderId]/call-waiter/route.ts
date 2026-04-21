import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  }

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, restaurantId: true, status: true, needsWaiter: true },
  });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (order.status === "paid" || order.status === "cancelled") {
    return NextResponse.json({ error: "order closed" }, { status: 409 });
  }

  if (order.needsWaiter) {
    return NextResponse.json({ ok: true, alreadyCalled: true });
  }

  await db.order.update({
    where: { id: orderId },
    data: { needsWaiter: true, waiterCalledAt: new Date() },
  });

  publishOrderEvent(tenant.id, { type: "order.waiter_called", orderId });

  return NextResponse.json({ ok: true });
}
