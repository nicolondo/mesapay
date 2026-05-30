import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";

/**
 * Cambio de estado de una reserva desde el dashboard del operador, y
 * acción de acreditar el abono del depósito a la cuenta.
 *
 *   PATCH { status: "confirmed" | "seated" | "completed" | "cancelled" | "no_show" }
 *   PATCH { action: "apply_deposit" }
 *
 * Depósito (abono al consumo, no reembolsable si no se presentan):
 *   - seated  → enlazamos la reserva con la cuenta abierta de la mesa
 *               (appliedOrderId) si existe; el depósito queda "paid".
 *   - apply_deposit → crea un Payment-crédito reservation_deposit en la
 *               cuenta (reduce lo pendiente). Sólo si la cuenta ya tiene
 *               consumo (subtotal > 0) para no cerrarla en falso.
 *   - no_show / cancelled con depósito pagado → forfeited (se retiene).
 *
 * Operator / mesero / admin. Tenant-scoped.
 */
const TRANSITIONS = [
  "confirmed",
  "seated",
  "completed",
  "cancelled",
  "no_show",
] as const;

const body = z.object({
  status: z.enum(TRANSITIONS).optional(),
  action: z.enum(["apply_deposit"]).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "mesero")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.status && !parsed.data.action)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const reservation = await db.reservation.findUnique({
    where: { id },
    select: {
      id: true,
      restaurantId: true,
      status: true,
      tableId: true,
      depositStatus: true,
      depositCents: true,
      depositTxId: true,
      appliedOrderId: true,
    },
  });
  if (!reservation || reservation.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // ── Acreditar el abono a la cuenta ────────────────────────────────
  if (parsed.data.action === "apply_deposit") {
    const applied = await applyDeposit(restaurantId, reservation);
    if (!applied.ok) {
      return NextResponse.json(
        { error: applied.reason, message: applied.message },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, applied: true });
  }

  const status = parsed.data.status!;
  await db.reservation.update({ where: { id }, data: { status } });

  // Efectos del depósito según el nuevo estado.
  if (
    status === "seated" &&
    reservation.depositStatus === "paid" &&
    !reservation.appliedOrderId
  ) {
    // Enlazar con la cuenta abierta de la mesa (si ya hay una). El abono
    // se acredita aparte con apply_deposit cuando la cuenta tenga consumo.
    const order = await db.order.findFirst({
      where: {
        tableId: reservation.tableId,
        restaurantId,
        status: { notIn: ["paid", "cancelled"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (order) {
      await db.reservation.update({
        where: { id },
        data: { appliedOrderId: order.id },
      });
    }
  }

  if (
    (status === "no_show" || status === "cancelled") &&
    reservation.depositStatus === "paid"
  ) {
    // No-show / cancelación con depósito pagado → el comercio lo retiene.
    await db.reservation.update({
      where: { id },
      data: { depositStatus: "forfeited" },
    });
  }

  publishOrderEvent(restaurantId, {
    type: "order.updated",
    orderId: `reservation:${id}`,
  });

  return NextResponse.json({ ok: true, status });
}

/**
 * Crea el Payment-crédito del depósito sobre la cuenta abierta de la
 * mesa. Guarda contra cerrar una cuenta vacía: exige subtotal > 0.
 */
async function applyDeposit(
  restaurantId: string,
  reservation: {
    id: string;
    tableId: string;
    depositStatus: string;
    depositCents: number | null;
    depositTxId: string | null;
    appliedOrderId: string | null;
  },
): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  if (reservation.depositStatus !== "paid" || !reservation.depositCents) {
    return {
      ok: false,
      reason: "no_deposit",
      message: "Esta reserva no tiene un depósito por acreditar.",
    };
  }

  const order = await db.order.findFirst({
    where: reservation.appliedOrderId
      ? { id: reservation.appliedOrderId }
      : {
          tableId: reservation.tableId,
          restaurantId,
          status: { notIn: ["paid", "cancelled"] },
        },
    orderBy: { createdAt: "desc" },
    select: { id: true, subtotalCents: true, status: true },
  });
  if (!order || order.status === "paid" || order.status === "cancelled") {
    return {
      ok: false,
      reason: "no_open_order",
      message:
        "No hay una cuenta abierta en esa mesa. Abrí el pedido y volvé a aplicar el abono.",
    };
  }
  if (order.subtotalCents <= 0) {
    return {
      ok: false,
      reason: "empty_order",
      message:
        "La cuenta todavía no tiene consumo. Aplicá el abono cuando haya pedidos.",
    };
  }

  const depositCents = reservation.depositCents;
  await db.$transaction(async (tx) => {
    const pay = await tx.payment.create({
      data: {
        orderId: order.id,
        method: "reservation_deposit",
        status: "approved",
        amountCents: depositCents,
        tipCents: 0,
        providerRef: reservation.depositTxId,
        settledAt: new Date(),
      },
    });
    await recomputeOrderTotalsInTx(tx, order.id);
    await tx.reservation.update({
      where: { id: reservation.id },
      data: {
        depositStatus: "applied",
        appliedOrderId: order.id,
        depositPaymentId: pay.id,
      },
    });
  });

  publishOrderEvent(restaurantId, { type: "order.updated", orderId: order.id });
  publishOrderEvent(restaurantId, {
    type: "order.updated",
    orderId: `reservation:${reservation.id}`,
  });
  return { ok: true };
}
