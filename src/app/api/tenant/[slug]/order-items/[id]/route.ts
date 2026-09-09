import { secureApi } from "@/lib/secureApi";
import { lockOrder } from "@/lib/orderLock";
import { recomputeOrderLinesInTx } from "@/lib/orders";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";

async function DELETEHandler(
  _req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  }

  const item = await db.orderItem.findUnique({
    where: { id },
    include: { order: true, round: true },
  });
  if (!item || item.order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // Diners can only cancel items the kitchen hasn't touched yet.
  if (item.kitchenStatus !== "placed") {
    return NextResponse.json(
      { error: "already_in_kitchen" },
      { status: 409 },
    );
  }
  if (["paid", "cancelled"].includes(item.order.status)) {
    return NextResponse.json({ error: "order_closed" }, { status: 409 });
  }

  const changed = await db.$transaction(async (tx) => {
    await lockOrder(tx, item.orderId);
    const current = await tx.orderItem.findUnique({ where: { id }, include: { order: true } });
    if (!current || current.kitchenStatus !== "placed" || ["paid", "cancelled", "paying"].includes(current.order.status)) return false;
    await tx.orderItem.delete({ where: { id: item.id } });

    if (item.roundId) {
      const remaining = await tx.orderItem.count({
        where: { roundId: item.roundId },
      });
      if (remaining === 0) {
        await tx.round.delete({ where: { id: item.roundId } });
      }
    }

    await recomputeOrderLinesInTx(tx, item.orderId);
    const live = await tx.orderItem.count({ where: { orderId: item.orderId, cancelledAt: null } });
    if (!live) await tx.order.update({ where: { id: item.orderId }, data: { status: "cancelled" } });
    return true;
  });

  if (!changed) return NextResponse.json({ error: "order_closed" }, { status: 409 });

  publishOrderEvent(tenant.id, {
    type: "order.updated",
    orderId: item.orderId,
  });

  return NextResponse.json({ ok: true });
}

export const DELETE = secureApi(DELETEHandler);
