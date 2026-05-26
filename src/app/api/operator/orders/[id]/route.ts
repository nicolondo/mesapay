import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { recordAuditEvent } from "@/lib/auditLog";

const schema = z.object({
  status: z.enum(["served", "cancelled"]),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  // Mesero también cancela órdenes (cliente se arrepintió antes de
  // que cocina toque algo). Tenant scope se verifica abajo.
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "mesero")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const order = await db.order.findUnique({ where: { id } });
  if (!order) return NextResponse.json({ error: "not found" }, { status: 404 });
  const activeId = await getActiveRestaurantId();
  if (order.restaurantId !== activeId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (order.status === "paid") {
    return NextResponse.json({ error: "order already paid" }, { status: 409 });
  }

  const now = new Date();

  // CANCELACIÓN COMPLETA — antes el endpoint sólo cambiaba
  // Order.status y cocina/bar (que filtran por Round.status) seguían
  // viendo los platos. Ahora:
  //   1. Verifica que NINGÚN item haya pasado de "placed". Si cocina
  //      ya empezó cualquier plato, rechazamos — el caller debe
  //      cancelar/comp ítem por ítem con motivo (ver
  //      /api/operator/order-items).
  //   2. Cascadea: items → cancelledAt, rondas → status cancelled,
  //      order → status cancelled. Todo en una transacción.
  //   3. Graba audit event.
  if (parsed.data.status === "cancelled") {
    const liveItems = await db.orderItem.findMany({
      where: { orderId: order.id, cancelledAt: null },
      select: { id: true, kitchenStatus: true, nameSnapshot: true, qty: true },
    });
    const kitchenStarted = liveItems.some(
      (i) => i.kitchenStatus !== "placed",
    );
    if (kitchenStarted) {
      return NextResponse.json(
        {
          error: "kitchen_started",
          message:
            "Cocina ya empezó algún plato. Cancelá / no cobres plato por plato con motivo.",
        },
        { status: 409 },
      );
    }

    const reason = "Orden completa cancelada";
    await db.$transaction([
      db.orderItem.updateMany({
        where: { orderId: order.id, cancelledAt: null },
        data: {
          cancelledAt: now,
          cancellationReason: reason,
          cancelledByEmail: session.user.email,
        },
      }),
      db.round.updateMany({
        where: { orderId: order.id, status: { not: "cancelled" } },
        data: {
          status: "cancelled",
          cancelledAt: now,
          cancelledByEmail: session.user.email,
          cancellationReason: reason,
          // El mesero ya está en la mesa cancelando — no hace falta
          // que vaya a avisar al cliente, marcamos el ack también.
          cancellationAckedAt: now,
          cancellationAckedByEmail: session.user.email,
        },
      }),
      db.order.update({
        where: { id: order.id },
        data: {
          status: "cancelled",
          subtotalCents: 0,
          totalCents: 0,
        },
      }),
    ]);

    await recordAuditEvent({
      kind: "order.cancel",
      restaurantId: order.restaurantId,
      target: { type: "order", id: order.id },
      summary: `Canceló orden ${order.shortCode} (${liveItems.length} ${liveItems.length === 1 ? "ítem" : "ítems"})`,
      diff: {
        before: { itemsCount: liveItems.length, status: order.status },
        after: { status: "cancelled" },
      },
    });

    publishOrderEvent(order.restaurantId, {
      type: "order.updated",
      orderId: order.id,
    });

    return NextResponse.json({ ok: true });
  }

  // status === "served" — marca la orden entera como servida. Sin
  // cascadear porque ese flow lo maneja Salón ítem-por-ítem; este
  // path es legacy y casi no se usa.
  await db.order.update({
    where: { id: order.id },
    data: {
      status: "served",
      servedAt: now,
    },
  });

  publishOrderEvent(order.restaurantId, {
    type: "order.updated",
    orderId: order.id,
  });

  return NextResponse.json({ ok: true });
}
