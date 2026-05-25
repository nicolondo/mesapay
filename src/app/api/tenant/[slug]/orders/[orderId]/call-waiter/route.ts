import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { sendPushToMeserosForTable } from "@/lib/push";

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
    select: {
      id: true,
      restaurantId: true,
      status: true,
      needsWaiter: true,
      tableId: true,
    },
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

  // Native push to meseros assigned to this table.
  void (async () => {
    const table = order.tableId
      ? await db.table.findUnique({
          where: { id: order.tableId },
          select: { number: true, label: true },
        })
      : null;
    if (!table || table.number < 0) return;
    const where = table.label ?? `Mesa ${table.number}`;
    await sendPushToMeserosForTable(tenant.id, table.number, {
      title: `${where} llama al mesero`,
      body: "Toca para abrir Salón",
      tag: `waiter-${orderId}`,
      url: "/mesero/salon",
    });
  })().catch((err) => console.error("[push:waiter]", err));

  return NextResponse.json({ ok: true });
}
