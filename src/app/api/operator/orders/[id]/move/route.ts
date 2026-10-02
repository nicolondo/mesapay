import { TABLE_MOVE_ADMIN_ONLY_ERROR } from "@/lib/tableMoveControl";
import { isTableMoveBlocked, tableMoveScopeError } from "@/lib/tableMoveGuard";
import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { lockOrder } from "@/lib/orderLock";
import { requireMutableOrderInTx } from "@/lib/orders";

const bodySchema = z.object({
  targetTableId: z.string().min(1),
});

/**
 * Mover una orden abierta de su mesa actual a otra. Caso clásico: el
 * cliente pidió cambio de mesa después de haber ordenado, o el mesero
 * acomodó accidentalmente la cuenta en la mesa equivocada.
 *
 * Reglas:
 *   - Ambas mesas deben pertenecer al mismo restaurante (tenant scope).
 *   - El mesero solo puede mover entre mesas dentro de su
 *     assignedTableNumbers (si tiene alguno asignado).
 *   - La mesa destino no debe tener otra orden abierta (evita merges
 *     accidentales que arruinarían la cuenta).
 *   - La orden de origen debe estar abierta (no paid / cancelled).
 *   - No se puede mover a la misma mesa (no-op).
 *
 * Publica `order.updated` con el restaurantId para que ambas mesas
 * (origen y destino) refresquen sus tarjetas en la grid de Mesas.
 */
async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const role = session?.user?.role;
  if (
    !session?.user ||
    (role !== "operator" &&
      role !== "platform_admin" &&
      role !== "group_admin" &&
      role !== "mesero")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  if (await isTableMoveBlocked(role, restaurantId)) {
    return NextResponse.json({ error: TABLE_MOVE_ADMIN_ONLY_ERROR }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const order = await db.order.findUnique({
    where: { id },
    select: {
      id: true,
      restaurantId: true,
      tableId: true,
      status: true,
      table: { select: { kind: true, number: true } },
    },
  });
  if (!order || order.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (order.status === "paid" || order.status === "cancelled") {
    return NextResponse.json(
      { error: "order_closed" },
      { status: 409 },
    );
  }
  if (order.tableId === parsed.data.targetTableId) {
    return NextResponse.json(
      { error: "same_table" },
      { status: 400 },
    );
  }

  const target = await db.table.findUnique({
    where: { id: parsed.data.targetTableId },
    select: { id: true, number: true, restaurantId: true, kind: true },
  });
  if (!target || target.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Una FACTURA MANUAL no es un lugar: ni se muda a una mesa ni una mesa
  // se muda a ella (sus platos no pasaron por cocina; los de una mesa
  // sí). La UI ya no ofrece esos destinos — esto es la defensa de fondo.
  if (order.table.kind === "manual" || target.kind === "manual") {
    return NextResponse.json({ error: "manual_invoice" }, { status: 409 });
  }

  const scopeError = await tableMoveScopeError({
    role,
    userId: session.user.id,
    restaurantId,
    sourceNumber: order.table.number,
    targetNumber: target.number,
  });
  if (scopeError) {
    return NextResponse.json({ error: scopeError }, { status: 403 });
  }

  // ¿Mesa destino ya tiene cuenta abierta? Si la juntáramos sería
  // un merge implícito de dos órdenes — preferimos pedirle al
  // operador que cierre/cancele antes de mover.
  const targetOpen = await db.order.findFirst({
    where: {
      tableId: target.id,
      status: { notIn: ["paid", "cancelled"] },
    },
    select: { id: true },
  });
  if (targetOpen) {
    return NextResponse.json(
      { error: "target_busy" },
      { status: 409 },
    );
  }

  const result = await db.$transaction(async (tx) => {
    // Share the movement mutex with item transfers: two requests cannot
    // both claim the same empty destination using an old occupancy read.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-item-move:${restaurantId}`}, 0))`;
    await lockOrder(tx, order.id);
    const current = await tx.order.findUnique({
      where: { id: order.id },
      select: { id: true, restaurantId: true, tableId: true, status: true, table: { select: { kind: true, number: true } } },
    });
    if (!current || current.restaurantId !== restaurantId) return { error: "not_found", status: 404 } as const;
    if (["paid", "paying", "cancelled"].includes(current.status)) return { error: "order_closed", status: 409 } as const;
    if (current.tableId === target.id) return { error: "same_table", status: 400 } as const;
    const currentTarget = await tx.table.findUnique({
      where: { id: target.id },
      select: { id: true, number: true, restaurantId: true, kind: true },
    });
    if (!currentTarget || currentTarget.restaurantId !== restaurantId) return { error: "not_found", status: 404 } as const;
    if (current.table.kind === "manual" || currentTarget.kind === "manual") return { error: "manual_invoice", status: 409 } as const;
    if (await isTableMoveBlocked(role, restaurantId, tx)) return { error: TABLE_MOVE_ADMIN_ONLY_ERROR, status: 403 } as const;
    const currentScopeError = await tableMoveScopeError({
      role, userId: session.user.id, restaurantId,
      sourceNumber: current.table.number, targetNumber: currentTarget.number,
    }, tx);
    if (currentScopeError) return { error: currentScopeError, status: 403 } as const;
    const occupied = await tx.order.findFirst({
      where: { restaurantId, tableId: currentTarget.id, status: { notIn: ["paid", "cancelled"] } },
      select: { id: true },
    });
    if (occupied) return { error: "target_busy", status: 409 } as const;
    await requireMutableOrderInTx(tx, current.id);
    await tx.order.update({ where: { id: current.id }, data: { tableId: currentTarget.id } });
    return { targetTableNumber: currentTarget.number } as const;
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

  // Refresh las dos tarjetas (origen y destino) en la grid de Mesas
  // + cualquier otra vista del flujo (Salón, kitchen) que dependa
  // del orderId. order.updated es el evento genérico que todas
  // escuchan.
  publishOrderEvent(restaurantId, {
    type: "order.updated",
    orderId: order.id,
  });

  return NextResponse.json({
    ok: true,
    targetTableNumber: result.targetTableNumber,
  });
}

export const POST = secureApi(POSTHandler);
