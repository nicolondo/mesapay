import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  // Mesero también ack'ea: cuando va a la mesa al ser llamado, despeja
  // el flag desde Salón con un tap.
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "mesero")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const order = await db.order.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, needsWaiter: true },
  });
  if (!order) return NextResponse.json({ error: "not found" }, { status: 404 });

  const activeId = await getActiveRestaurantId();
  if (order.restaurantId !== activeId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!order.needsWaiter) {
    return NextResponse.json({ ok: true, alreadyAcked: true });
  }

  await db.order.update({
    where: { id: order.id },
    data: { needsWaiter: false, waiterCalledAt: null },
  });

  publishOrderEvent(order.restaurantId, {
    type: "order.waiter_ack",
    orderId: order.id,
  });

  return NextResponse.json({ ok: true });
}
