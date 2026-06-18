import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  computeOpenShiftMetrics,
  getCurrentShift,
  isCashMethod,
  listOpenOrders,
} from "@/lib/shift";
import { publishOrderEvent } from "@/lib/events";
import { buildCashSnapshot } from "@/lib/cashBox";
import { resolveShiftPolicy } from "@/lib/staffPolicies";

const schema = z.object({
  // Efectivo físico contado por el cajero. Puede ser cero si abrieron sin
  // fondo y no se cobró nada en efectivo.
  // Cap = $100M COP en cents (subido desde $1M, que rechazaba turnos
  // legítimos cash-heavy con un mensaje "invalid" poco útil).
  declaredCashCents: z.number().int().min(0).max(10_000_000_000),
  notes: z.string().max(2000).optional(),
  // Operator override: cerrar AUNQUE haya órdenes abiertas. UI no lo
  // ofrece todavía pero el endpoint lo soporta para soporte en producción.
  forceOpenOrders: z.boolean().optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // Surface the actual field issue instead of a bare "invalid" —
    // tellers were getting that as the only feedback when they
    // declared cash above the (too-low) cap, with no clue why.
    const issue = parsed.error.issues[0];
    const message =
      issue?.path[0] === "declaredCashCents"
        ? "El monto declarado está fuera de rango."
        : (issue?.message ?? "Datos inválidos.");
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const { declaredCashCents, notes, forceOpenOrders } = parsed.data;

  const shift = await getCurrentShift(restaurantId);
  if (!shift) {
    return NextResponse.json(
      { error: "no hay turno abierto" },
      { status: 409 },
    );
  }

  // Bloqueo: si hay cuentas vivas, no se puede cerrar (a menos que un
  // platform_admin pase forceOpenOrders=true desde soporte).
  const openOrders = await listOpenOrders(restaurantId, shift.openedAt);
  if (openOrders.length > 0 && !forceOpenOrders) {
    return NextResponse.json(
      {
        error: "hay órdenes abiertas",
        openOrders: openOrders.map((o) => ({
          id: o.id,
          shortCode: o.shortCode,
          status: o.status,
          totalCents: o.totalCents,
          tableLabel: o.table
            ? o.table.label ?? `Mesa ${o.table.number}`
            : "Para llevar",
        })),
      },
      { status: 409 },
    );
  }

  const metrics = await computeOpenShiftMetrics(restaurantId, shift);
  // Esperado en el cajón = saldo de la caja general (descuenta egresos
  // e ingresos y, en by_waiter, las bases entregadas a meseros + las
  // devoluciones). No basta opening + cash: ignoraría los egresos.
  const tenantPolicy = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { shiftPolicy: true },
  });
  const snap = await buildCashSnapshot(
    restaurantId,
    resolveShiftPolicy(tenantPolicy?.shiftPolicy),
  );
  const expectedCashCents = snap.general.balanceCents;
  const cashDiffCents = declaredCashCents - expectedCashCents;

  // Pin payments + close shift atomically so we never end up with a closed
  // shift missing its payments (or payments pinned but shift still open).
  const closed = await db.$transaction(async (tx) => {
    // Re-read the open shift inside the tx to defend against a parallel
    // close (rare but possible if the operator clicks twice).
    const fresh = await tx.shift.findFirst({
      where: { id: shift.id, status: "open" },
    });
    if (!fresh) {
      throw new Error("shift already closed");
    }

    await tx.payment.updateMany({
      where: {
        status: "approved",
        shiftId: null,
        createdAt: { gte: shift.openedAt },
        order: { restaurantId },
      },
      data: { shiftId: shift.id },
    });

    return tx.shift.update({
      where: { id: shift.id },
      data: {
        status: "closed",
        closedAt: new Date(),
        closedById: session.user.id,
        declaredCashCents,
        expectedCashCents,
        cashDiffCents,
        notes: notes ?? null,
      },
    });
  }).catch((err) => {
    if (err instanceof Error && err.message === "shift already closed") {
      return null;
    }
    throw err;
  });

  if (!closed) {
    return NextResponse.json(
      { error: "el turno ya estaba cerrado" },
      { status: 409 },
    );
  }

  publishOrderEvent(restaurantId, { type: "cash.updated" });

  return NextResponse.json({
    ok: true,
    shiftId: closed.id,
    expectedCashCents,
    cashDiffCents,
    breakdown: {
      grossCents: metrics.grossCents,
      tipCents: metrics.tipCents,
      cashCents: metrics.cashCents,
      payments: metrics.payments,
      ordersClosed: metrics.ordersClosed,
      byMethod: metrics.byMethod.map((b) => ({
        method: b.method,
        count: b.count,
        sumCents: b.sumCents,
        // Hint for the UI so it can label cash rows distinctively.
        isCash: isCashMethod(b.method),
      })),
    },
  });
}
