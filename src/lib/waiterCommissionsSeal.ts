/**
 * ===== SELLADO de la comisión del mesero al cobrar la cuenta =====
 *
 * Único punto de entrada: `sealOrderCommission(client, orderId)`, llamado
 * desde `recomputeOrderTotalsInTx` (src/lib/orderTotals.ts) cada vez que
 * una cuenta queda saldada. Con la MISMA transacción del cobro: si el pago
 * se revierte, el sello se revierte con él.
 *
 * Qué sella (`Order.commission*`): quién atendió la cuenta, su % vigente,
 * la base y la comisión ya calculada. Cambiar el % del mesero después no
 * toca cuentas cobradas (sólo futuras) — igual que zenith sella
 * `sales.commission_pct` al confirmar la venta.
 *
 * ── Quién es «el mesero de la cuenta» ────────────────────────────────────
 * `Order` no guarda mesero. Se resuelve en este orden:
 *
 *  1. Quien COBRÓ: `Payment.collectedByUserId` de los pagos aprobados, si
 *     ese usuario es un mesero del comercio. Es la misma atribución que
 *     usan las propinas `by_waiter` y la vista «Yo». Si cobraron varios
 *     meseros (cuenta dividida), gana el que cobró más plata.
 *  2. Si nadie del staff cobró (el comensal pagó desde su QR, o cobró el
 *     operador en caja): el mesero que tiene la MESA asignada
 *     (`User.assignedTableNumbers`), sólo si es exactamente uno y está
 *     activo. Dos meseros en la misma mesa = ambiguo = no comisiona.
 *  3. Nadie → la cuenta no comisiona (queda sin sellar).
 *
 * ── Best-effort, siempre ─────────────────────────────────────────────────
 * El cobro es la ruta caliente del producto. Esta función NUNCA lanza:
 * cualquier error se registra con `[comisiones]` y devuelve
 * `{ sealed: false, reason: "error" }`. Y es idempotente: no re-sella una
 * cuenta con `commissionSealedAt` (el `updateMany` lleva ese guardia para
 * que dos rieles del mismo cobro no compitan).
 */

import type { Prisma } from "@prisma/client";
import { sealCommission } from "./waiterCommissions";

/** Lo que el sellado necesita del cliente Prisma (vale `db` o una `tx`). */
export type CommissionSealClient = Pick<Prisma.TransactionClient, "order" | "user">;

export type SealResult =
  | { sealed: true; waiterId: string; bps: number; baseCents: number; commissionCents: number }
  | {
      sealed: false;
      reason:
        | "not_found"
        | "not_paid"
        | "already_sealed"
        | "no_waiter"
        | "no_rate"
        | "zero_base"
        | "race"
        | "error";
    };

const ORDER_SELECT = {
  id: true,
  restaurantId: true,
  status: true,
  subtotalCents: true,
  discountCents: true,
  commissionSealedAt: true,
  table: { select: { number: true } },
  payments: {
    where: { status: "approved" as const, collectedByUserId: { not: null } },
    select: { collectedByUserId: true, amountCents: true },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.OrderSelect;

type OrderForSeal = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

type Waiter = { id: string; waiterCommissionBps: number | null };

const WAITER_SELECT = { id: true, waiterCommissionBps: true } as const;

/** El mesero de la cuenta según las reglas de arriba, o null. */
export async function resolveOrderWaiter(
  client: CommissionSealClient,
  order: Pick<OrderForSeal, "restaurantId" | "table" | "payments">,
): Promise<Waiter | null> {
  // 1. Quien cobró (por plata cobrada, desempate por orden de cobro).
  const collected = new Map<string, number>();
  for (const p of order.payments) {
    if (!p.collectedByUserId) continue;
    collected.set(p.collectedByUserId, (collected.get(p.collectedByUserId) ?? 0) + p.amountCents);
  }
  if (collected.size > 0) {
    const meseros = await client.user.findMany({
      where: { id: { in: [...collected.keys()] }, restaurantId: order.restaurantId, role: "mesero" },
      select: WAITER_SELECT,
    });
    if (meseros.length > 0) {
      const byId = new Map(meseros.map((m) => [m.id, m]));
      let best: Waiter | null = null;
      let bestCents = -1;
      for (const [id, cents] of collected) {
        const m = byId.get(id);
        if (m && cents > bestCents) {
          best = m;
          bestCents = cents;
        }
      }
      return best;
    }
  }

  // 2. La mesa asignada (mesas reales: número ≥ 0; recogida y factura
  //    manual llevan número negativo y no tienen mesero de sección).
  const tableNumber = order.table?.number;
  if (tableNumber == null || tableNumber < 0) return null;
  const assigned = await client.user.findMany({
    where: {
      restaurantId: order.restaurantId,
      role: "mesero",
      disabledAt: null,
      assignedTableNumbers: { has: tableNumber },
    },
    select: WAITER_SELECT,
    take: 2,
  });
  return assigned.length === 1 ? assigned[0] : null;
}

/**
 * Sella la comisión de una cuenta ya cobrada. Idempotente y sin
 * excepciones (ver cabecera).
 */
export async function sealOrderCommission(
  client: CommissionSealClient,
  orderId: string,
): Promise<SealResult> {
  try {
    const order = await client.order.findUnique({ where: { id: orderId }, select: ORDER_SELECT });
    if (!order) return { sealed: false, reason: "not_found" };
    if (order.commissionSealedAt) return { sealed: false, reason: "already_sealed" };
    if (order.status !== "paid") return { sealed: false, reason: "not_paid" };

    const waiter = await resolveOrderWaiter(client, order);
    if (!waiter) return { sealed: false, reason: "no_waiter" };
    if (waiter.waiterCommissionBps == null) return { sealed: false, reason: "no_rate" };

    const sealed = sealCommission({
      waiterBps: waiter.waiterCommissionBps,
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
    });
    if (!sealed) return { sealed: false, reason: "no_rate" };
    // Cortesías (comp) y cuentas en $0: no hay nada que liquidar y una
    // fila en cero sólo ensuciaría el reporte.
    if (sealed.baseCents <= 0) return { sealed: false, reason: "zero_base" };

    const res = await client.order.updateMany({
      where: { id: orderId, commissionSealedAt: null },
      data: {
        commissionWaiterId: waiter.id,
        commissionBps: sealed.bps,
        commissionBaseCents: sealed.baseCents,
        commissionCents: sealed.commissionCents,
        commissionSealedAt: new Date(),
      },
    });
    if (res.count === 0) return { sealed: false, reason: "race" };
    return { sealed: true, waiterId: waiter.id, ...sealed };
  } catch (err) {
    console.error("[comisiones] no se pudo sellar la comisión de la cuenta", {
      orderId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { sealed: false, reason: "error" };
  }
}
