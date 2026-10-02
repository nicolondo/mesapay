import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { recordAuditEvent } from "@/lib/auditLog";
import { lockOrder } from "@/lib/orderLock";
import { requireMutableOrderInTx } from "@/lib/orders";
import { assertCancellationAllowed, hasPreparationStarted } from "@/lib/orders/cancellationPolicy";

const schema = z.object({
  status: z.enum(["served", "cancelled"]),
});

async function PATCHHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  // Mesero también cancela órdenes (cliente se arrepintió antes de
  // que cocina toque algo). Tenant scope se verifica abajo.
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" && session.user.role !== "group_admin" &&
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

  const order = await db.order.findUnique({
    where: { id },
    include: { table: { select: { kind: true } } },
  });
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
    const result = await db.$transaction(async (tx) => {
      // Kitchen, payments and cancellations serialize on the same order.
      const current = await requireMutableOrderInTx(tx, order.id);
      const table = await tx.table.findUniqueOrThrow({ where: { id: current.tableId }, select: { kind: true } });
      const liveItems = await tx.orderItem.findMany({
        where: { orderId: order.id, cancelledAt: null, OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }] },
      });
      assertCancellationAllowed(session.user.role, liveItems, table.kind);
      // Administrators still resolve prepared dishes individually, with
      // a reason and comp/cancel accounting, rather than erase the bill.
      if (liveItems.some((item) => hasPreparationStarted(item, table.kind))) {
        return { kitchenStarted: true as const };
      }
      const reason = "Orden completa cancelada";
      await tx.orderItem.updateMany({
        where: { orderId: order.id, cancelledAt: null },
        data: {
          cancelledAt: now,
          cancellationReason: reason,
          cancelledByEmail: session.user.email,
          cancellationKind: "cancel",
        },
      });
      await tx.round.updateMany({
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
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "cancelled",
          subtotalCents: 0,
          taxCents: 0,
          totalCents: 0,
        },
      });
      return { kitchenStarted: false as const, itemsCount: liveItems.length, previousStatus: current.status };
    });
    if (result.kitchenStarted) return NextResponse.json({ error: "kitchen_started" }, { status: 409 });

    await recordAuditEvent({
      kind: "order.cancel",
      restaurantId: order.restaurantId,
      target: { type: "order", id: order.id },
      summary: `Canceló orden ${order.shortCode} (${result.itemsCount} ${result.itemsCount === 1 ? "ítem" : "ítems"})`,
      diff: {
        before: { itemsCount: result.itemsCount, status: result.previousStatus },
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
  await db.$transaction(async (tx) => {
    await lockOrder(tx, order.id);
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { table: { select: { kind: true } } } });
    if (["paid", "paying", "cancelled"].includes(current.status)) throw new Error("order_closed");
    if (current.table.kind !== "manual") {
      // Legacy whole-order service also counts as delivery. A later status
      // reset must not let staff remove the dishes from the bill.
      await tx.orderItem.updateMany({
        where: { orderId: order.id, cancelledAt: null, menuItemId: { not: null }, preparationFirstStartedAt: null,
          OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }] },
        data: { preparationFirstStartedAt: now },
      });
    }
    await tx.order.update({ where: { id: order.id }, data: { status: "served", servedAt: now } });
  });

  publishOrderEvent(order.restaurantId, {
    type: "order.updated",
    orderId: order.id,
  });

  return NextResponse.json({ ok: true });
}

export const PATCH = secureApi(PATCHHandler);
