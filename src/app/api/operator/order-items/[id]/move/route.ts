import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getLocale } from "next-intl/server";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { publishOrderEvent } from "@/lib/events";

const bodySchema = z.object({ targetTableId: z.string().min(1) });

/** Consecutivo corto de la orden (mismo formato que el checkout). */
function shortCode() {
  const n = Math.floor(1000 + Math.random() * 9000);
  const letters = ["T", "M", "C", "N", "B"][Math.floor(Math.random() * 5)];
  return `${letters}-${n}`;
}

/**
 * Mover UN plato (order-item) a otra mesa. Caso: el mesero cargó un plato
 * en la mesa equivocada. El ítem se reasigna al pedido ABIERTO de la mesa
 * destino (se crea uno si no hay), en una ronda nueva que conserva su
 * estado de cocina. Se recomputa el subtotal de ambos pedidos; si el de
 * origen queda sin platos vivos, se cierra.
 *
 * A diferencia de mover el pedido entero, acá SÍ se puede sumar a una mesa
 * destino con cuenta abierta — el plato se une a esa cuenta.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const role = session?.user?.role;
  if (
    !session?.user ||
    (role !== "operator" && role !== "platform_admin" && role !== "mesero")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const item = await db.orderItem.findUnique({
    where: { id },
    select: {
      id: true,
      orderId: true,
      cancelledAt: true,
      servedAt: true,
      kitchenStatus: true,
      order: {
        select: {
          restaurantId: true,
          tableId: true,
          status: true,
          locale: true,
          servingMode: true,
        },
      },
    },
  });
  if (!item || item.order.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (item.cancelledAt) {
    return NextResponse.json({ error: "item_cancelled" }, { status: 409 });
  }
  if (item.servedAt) {
    return NextResponse.json(
      { error: "item_served", message: "Un plato ya entregado no se puede mover." },
      { status: 409 },
    );
  }
  if (item.order.status === "paid" || item.order.status === "cancelled") {
    return NextResponse.json({ error: "order_closed" }, { status: 409 });
  }
  if (item.order.tableId === parsed.data.targetTableId) {
    return NextResponse.json({ error: "same_table" }, { status: 400 });
  }

  const target = await db.table.findUnique({
    where: { id: parsed.data.targetTableId },
    select: { id: true, number: true, restaurantId: true },
  });
  if (!target || target.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Scope de mesa para meseros con asignación (empty = todas).
  if (role === "mesero") {
    const me = await db.user.findUnique({
      where: { id: session.user.id },
      select: { assignedTableNumbers: true },
    });
    const nums = me?.assignedTableNumbers ?? [];
    if (nums.length > 0 && !nums.includes(target.number)) {
      return NextResponse.json(
        { error: "target_out_of_scope", message: "Esa mesa no está en tu sección." },
        { status: 403 },
      );
    }
  }

  const sourceOrderId = item.orderId;
  const roundStatus = item.kitchenStatus; // "placed" | "in_kitchen" | "ready"
  const locale = item.order.locale ?? (await getLocale());

  const destOrderId = await db.$transaction(async (tx) => {
    // Pedido destino: el abierto de esa mesa, o uno nuevo.
    const open = await tx.order.findFirst({
      where: { tableId: target.id, status: { notIn: ["paid", "cancelled"] } },
      select: { id: true },
    });
    const dest =
      open ??
      (await tx.order.create({
        data: {
          restaurantId,
          tableId: target.id,
          status: "placed",
          shortCode: shortCode(),
          servingMode: item.order.servingMode,
          locale,
        },
        select: { id: true },
      }));

    const now = new Date();
    const seq = await tx.round.count({ where: { orderId: dest.id } });
    const round = await tx.round.create({
      data: {
        orderId: dest.id,
        seq: seq + 1,
        status: roundStatus,
        readyAt: roundStatus === "ready" ? now : null,
        ...(roundStatus !== "placed" ? { kitchenStartedAt: now } : {}),
      },
      select: { id: true },
    });

    await tx.orderItem.update({
      where: { id: item.id },
      data: { orderId: dest.id, roundId: round.id },
    });
    return dest.id;
  });

  // Recomputar subtotales de ambos (idempotente) + cerrar el origen si
  // quedó sin platos vivos.
  await syncOrderSubtotalFromLiveItems(sourceOrderId);
  await syncOrderSubtotalFromLiveItems(destOrderId);
  const liveLeft = await db.orderItem.count({
    where: {
      orderId: sourceOrderId,
      cancelledAt: null,
      OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
    },
  });
  if (liveLeft === 0) {
    await db.order.updateMany({
      where: { id: sourceOrderId, status: { notIn: ["paid", "paying", "cancelled"] } },
      data: { status: "cancelled" },
    });
  }

  // Un solo evento a nivel restaurante refresca ambas mesas en la grid.
  publishOrderEvent(restaurantId, { type: "order.updated", orderId: sourceOrderId });

  return NextResponse.json({ ok: true, targetTableNumber: target.number });
}
