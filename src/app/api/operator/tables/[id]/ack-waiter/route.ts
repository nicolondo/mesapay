import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";

/**
 * Ack de una llamada al mesero PRE-orden (cuando vive en
 * Table.waiterCalledAt). Para llamadas con orden activa el ack
 * sigue siendo /api/operator/orders/[id]/ack-waiter (legacy y
 * sigue usándose).
 *
 * Same role gate que el ack de order — mesero también puede.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "mesero")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const table = await db.table.findUnique({
    where: { id },
    select: {
      id: true,
      restaurantId: true,
      waiterCalledAt: true,
      waiterAckedAt: true,
    },
  });
  if (!table) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const activeId = await getActiveRestaurantId();
  if (table.restaurantId !== activeId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (
    !table.waiterCalledAt ||
    (table.waiterAckedAt &&
      table.waiterAckedAt.getTime() >= table.waiterCalledAt.getTime())
  ) {
    return NextResponse.json({ ok: true, alreadyAcked: true });
  }

  await db.table.update({
    where: { id: table.id },
    data: { waiterAckedAt: new Date() },
  });

  publishOrderEvent(table.restaurantId, {
    type: "order.waiter_ack",
    orderId: `table:${table.id}`,
  });

  return NextResponse.json({ ok: true });
}
