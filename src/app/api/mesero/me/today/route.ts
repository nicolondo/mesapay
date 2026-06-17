import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  getCurrentMeseroShift,
  startOfMeseroDay,
} from "@/lib/meseroShift";
import {
  resolveTipPolicy,
  resolveShiftPolicy,
} from "@/lib/staffPolicies";
import { isCashMethod } from "@/lib/shift";

/**
 * Stats personales del mesero para la vista "Yo". Cubre:
 *   - propinas acumuladas (suma de Payment.tipCents con
 *     collectedByUserId = self, status=approved)
 *   - ventas (suma de Payment.amountCents - tipCents)
 *   - count de pagos
 *   - count de mesas únicas atendidas
 *   - rango: desde el turno personal abierto (si by_waiter + abierto)
 *     o desde medianoche local
 *
 * Las propinas aparecen como cifra personal solo cuando
 * tipPolicy="by_waiter". En "shared" devolvemos null en tipsCents
 * para que el cliente muestre un copy distinto ("propinas del local").
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "mesero") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const userId = session.user.id;
  const restaurantId = session.user.restaurantId;
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { tipPolicy: true, shiftPolicy: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const tipPolicy = resolveTipPolicy(tenant.tipPolicy);
  const shiftPolicy = resolveShiftPolicy(tenant.shiftPolicy);

  const openShift =
    shiftPolicy === "by_waiter"
      ? await getCurrentMeseroShift(userId)
      : null;
  const sinceDate = startOfMeseroDay(openShift?.openedAt ?? null);

  const payments = await db.payment.findMany({
    where: {
      collectedByUserId: userId,
      status: "approved",
      settledAt: { gte: sinceDate },
    },
    select: {
      id: true,
      amountCents: true,
      tipCents: true,
      method: true,
      orderId: true,
      settledAt: true,
      order: { select: { tableId: true } },
    },
  });

  const tipsCents = payments.reduce((s, p) => s + p.tipCents, 0);
  const salesCents = payments.reduce(
    (s, p) => s + (p.amountCents - p.tipCents),
    0,
  );
  // Efectivo cobrado por el mesero en la ventana — alimenta el arqueo
  // personal al cerrar (esperado = base inicial + efectivo cobrado).
  const cashCollectedCents = payments.reduce(
    (s, p) => (isCashMethod(p.method) ? s + p.amountCents : s),
    0,
  );
  const paymentCount = payments.length;
  const tableSet = new Set<string>();
  for (const p of payments) {
    if (p.order?.tableId) tableSet.add(p.order.tableId);
  }
  const tableCount = tableSet.size;

  return NextResponse.json({
    sinceIso: sinceDate.toISOString(),
    tipPolicy,
    shiftPolicy,
    shift: openShift
      ? {
          id: openShift.id,
          openedAtIso: openShift.openedAt.toISOString(),
          // Para el arqueo al cerrar: base con la que abrió + efectivo
          // cobrado hasta ahora → esperado en su caja.
          openingCashCents: openShift.openingCashCents,
          cashCollectedCents,
        }
      : null,
    // En shared el cliente no debe mostrar "Tus propinas: $X" porque
    // el monto es del local. Mantenemos la cifra raw para auditoría.
    tipsCents: tipPolicy === "by_waiter" ? tipsCents : null,
    tipsRawCents: tipsCents,
    salesCents,
    paymentCount,
    tableCount,
  });
}
