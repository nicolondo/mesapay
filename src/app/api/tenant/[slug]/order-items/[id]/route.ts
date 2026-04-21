import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";

export async function DELETE(
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

  await db.$transaction(async (tx) => {
    await tx.orderItem.delete({ where: { id: item.id } });

    if (item.roundId) {
      const remaining = await tx.orderItem.count({
        where: { roundId: item.roundId },
      });
      if (remaining === 0) {
        await tx.round.delete({ where: { id: item.roundId } });
      }
    }

    const orderItems = await tx.orderItem.findMany({
      where: { orderId: item.orderId },
    });
    const subtotal = orderItems.reduce(
      (s, i) => s + i.priceCentsSnapshot * i.qty,
      0,
    );

    if (orderItems.length === 0) {
      await tx.order.update({
        where: { id: item.orderId },
        data: {
          subtotalCents: 0,
          totalCents: 0,
          status: "cancelled",
        },
      });
    } else {
      await tx.order.update({
        where: { id: item.orderId },
        data: {
          subtotalCents: subtotal,
          totalCents: subtotal,
        },
      });
    }
  });

  publishOrderEvent(tenant.id, {
    type: "order.updated",
    orderId: item.orderId,
  });

  return NextResponse.json({ ok: true });
}
