import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";

/**
 * Waiter says "I went to the table and told the customer". Removes the
 * cancelled round from Salón's pending-ack list.
 */
export async function POST(
  _req: Request,
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
  const round = await db.round.findUnique({
    where: { id },
    include: { order: true },
  });
  if (!round) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const activeId = await getActiveRestaurantId();
  if (round.order.restaurantId !== activeId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (round.status !== "cancelled") {
    return NextResponse.json({ error: "not_cancelled" }, { status: 400 });
  }
  if (round.cancellationAckedAt) {
    // Idempotent — second click is fine.
    return NextResponse.json({ ok: true, alreadyAcked: true });
  }
  await db.round.update({
    where: { id: round.id },
    data: {
      cancellationAckedAt: new Date(),
      cancellationAckedByEmail: session.user.email,
    },
  });
  publishOrderEvent(round.order.restaurantId, {
    type: "order.updated",
    orderId: round.orderId,
  });
  return NextResponse.json({ ok: true });
}
