import { secureApi } from "@/lib/secureApi";
import { shortCode } from "@/lib/shortCode";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getLocale } from "next-intl/server";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { publishOrderEvent } from "@/lib/events";
import { recordAuditEvent } from "@/lib/auditLog";
import {
  checkMoveAllowed,
  destinationRoundState,
  syncedTargetOrderStatus,
} from "@/lib/moveOrderItem";

const bodySchema = z.object({ targetTableId: z.string().min(1) });

/** Consecutivo corto de la orden (mismo formato que el checkout). */


/**
 * Mover UN plato (order-item) a otra mesa. Casos reales: el comensal se
 * cambió de mesa a mitad de la comida, o el mesero cargó el plato en la mesa
 * equivocada. Sin esto hay que cancelar y volver a pedir, lo que ensucia el
 * historial y re-dispara la comanda de cocina.
 *
 * El plato se reasigna al pedido ABIERTO de la mesa destino (se crea uno si
 * no hay) dentro de una ronda nueva que refleja su estado de cocina. Los
 * subtotales de LAS DOS cuentas se recalculan con la función canónica, y las
 * dos reciben evento en vivo para que Salón se actualice en ambas puntas.
 *
 * Los errores viajan como código (`error`), nunca como texto: el cliente los
 * traduce. Este endpoint no puede hardcodear español — MESAPAY es trilingüe.
 */
async function POSTHandler(
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
      roundId: true,
      qty: true,
      nameSnapshot: true,
      priceCentsSnapshot: true,
      cancelledAt: true,
      servedAt: true,
      kitchenStatus: true,
      preparationStartedAt: true,
      order: {
        select: {
          restaurantId: true,
          tableId: true,
          status: true,
          locale: true,
          servingMode: true,
          table: { select: { number: true } },
        },
      },
    },
  });
  if (!item || item.order.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
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
      return NextResponse.json({ error: "target_out_of_scope" }, { status: 403 });
    }
  }

  // Cuenta viva de la mesa destino. El filtro deja pasar a propósito las que
  // están en cobro (`paying`): las necesitamos para poder RECHAZAR el
  // movimiento. Si las excluyéramos acá, una mesa cobrando terminaría con una
  // SEGUNDA cuenta abierta en paralelo — peor que rebotar.
  const liveTargetOrder = await db.order.findFirst({
    where: { tableId: target.id, status: { notIn: ["paid", "cancelled"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });

  const gate = checkMoveAllowed({
    itemCancelled: !!item.cancelledAt,
    sourceStatus: item.order.status,
    sourceTableId: item.order.tableId,
    targetTableId: target.id,
    targetStatus: liveTargetOrder?.status ?? null,
  });
  if (!gate.ok) {
    // same_table es un error de input del cliente; el resto son conflictos
    // de estado que el mesero tiene que resolver antes de reintentar.
    const status = gate.reason === "same_table" ? 400 : 409;
    return NextResponse.json({ error: gate.reason }, { status });
  }

  const sourceOrderId = item.orderId;
  const sourceRoundId = item.roundId;
  const locale = item.order.locale ?? (await getLocale());
  const now = new Date();
  // El plato conserva kitchenStatus / preparationStartedAt / servedAt: mover
  // no es re-pedir. La ronda destino se crea espejando ese estado para que la
  // comanda no se vuelva a disparar en la mesa nueva.
  const roundState = destinationRoundState(item, now);

  const destOrderId = await db.$transaction(async (tx) => {
    const dest =
      liveTargetOrder ??
      (await tx.order.create({
        data: {
          restaurantId,
          tableId: target.id,
          // La cuenta nueva arranca en el estado del plato que la abre: si
          // llega un plato ya servido no tiene sentido nacer en "placed".
          status: roundState.status,
          shortCode: shortCode(),
          servingMode: item.order.servingMode,
          locale,
        },
        select: { id: true, status: true },
      }));

    // seq = max + 1, no count + 1: las rondas se pueden borrar (ver el
    // DELETE de tenant order-items y la limpieza de abajo), y con count
    // dos rondas distintas pueden pelearse el mismo seq contra el
    // @@unique([orderId, seq]).
    const last = await tx.round.findFirst({
      where: { orderId: dest.id },
      orderBy: { seq: "desc" },
      select: { seq: true },
    });
    const round = await tx.round.create({
      data: {
        orderId: dest.id,
        seq: (last?.seq ?? 0) + 1,
        status: roundState.status,
        kitchenStartedAt: roundState.kitchenStartedAt,
        readyAt: roundState.readyAt,
      },
      select: { id: true },
    });

    await tx.orderItem.update({
      where: { id: item.id },
      data: { orderId: dest.id, roundId: round.id },
    });

    // La ronda de ORIGEN puede haber quedado sin un solo item. La borramos
    // en vez de marcarla "cancelled" como hace el cancel de platos: acá no se
    // canceló nada, y una ronda cancelada aparecería en Salón como un
    // pendiente falso de "avisarle al cliente". Sin items no hay nada que
    // auditar, y dejarla viva trabaría el roll-up a "served" de la cuenta
    // origen (ese chequeo exige que TODAS las rondas estén served/cancelled).
    if (sourceRoundId) {
      const left = await tx.orderItem.count({
        where: { roundId: sourceRoundId },
      });
      if (left === 0) {
        await tx.round.delete({ where: { id: sourceRoundId } });
      }
    }

    // Alinear el status de la cuenta destino con la ronda entrante cuando
    // corresponda (ej: mesa ya "served" que recibe un plato por preparar).
    const synced = syncedTargetOrderStatus(dest.status, roundState.status);
    if (synced) {
      await tx.order.update({
        where: { id: dest.id },
        data: {
          status: synced,
          // Si la mesa deja de estar servida, el sello de servida miente.
          ...(synced !== "served" ? { servedAt: null } : {}),
        },
      });
    }
    return dest.id;
  });

  // Recomputar subtotales de AMBAS cuentas (idempotente). Sin esto la cuenta
  // origen sigue cobrando un plato que ya no tiene y la destino regala el que
  // recibió. Los gates de arriba garantizan que ninguna esté en cobro, que es
  // justo el caso en que esta función se niega a escribir.
  await syncOrderSubtotalFromLiveItems(sourceOrderId);
  await syncOrderSubtotalFromLiveItems(destOrderId);

  // Si la cuenta origen quedó sin platos vivos, se cierra y libera la mesa.
  const liveLeft = await db.orderItem.count({
    where: {
      orderId: sourceOrderId,
      cancelledAt: null,
      OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
    },
  });
  if (liveLeft === 0) {
    await db.order.updateMany({
      where: {
        id: sourceOrderId,
        status: { notIn: ["paid", "paying", "cancelled"] },
      },
      data: { status: "cancelled" },
    });
  }

  // Mover plata entre cuentas es sensible: queda en la bitácora igual que el
  // cancel / comp de platos.
  await recordAuditEvent({
    kind: "order_item.move",
    restaurantId,
    target: { type: "order_item", id: item.id },
    summary: `Movió ${item.qty}× ${item.nameSnapshot} de Mesa ${item.order.table.number} a Mesa ${target.number}`,
    diff: {
      before: { orderId: sourceOrderId, tableNumber: item.order.table.number },
      after: { orderId: destOrderId, tableNumber: target.number },
    },
  });

  // Las dos cuentas cambiaron. Hay pantallas suscritas por orderId (la vista
  // en vivo del comensal filtra `data.orderId !== orderId`), así que un solo
  // evento dejaría a la mesa destino sin enterarse de que le cayó un plato.
  publishOrderEvent(restaurantId, {
    type: "order.updated",
    orderId: sourceOrderId,
  });
  publishOrderEvent(restaurantId, {
    type: "order.updated",
    orderId: destOrderId,
  });

  return NextResponse.json({ ok: true, targetTableNumber: target.number });
}

export const POST = secureApi(POSTHandler);
