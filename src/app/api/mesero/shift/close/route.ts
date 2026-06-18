import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getCurrentMeseroShift } from "@/lib/meseroShift";
import { isCashMethod } from "@/lib/shift";
import { publishOrderEvent } from "@/lib/events";

const schema = z.object({
  // Efectivo físico que el mesero contó en su caja al cerrar. Cap =
  // $100M COP en cents, igual que el cierre global.
  declaredCashCents: z.number().int().min(0).max(10_000_000_000),
});

/**
 * Cierra el turno personal abierto del mesero con arqueo de su propia
 * caja: declara el efectivo contado y se calcula lo esperado (base +
 * efectivo cobrado por él) y la diferencia. Devuelve el resumen para
 * que la UI muestre un summary modal al cerrar.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "mesero") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const userId = session.user.id;

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", message: "El monto declarado no es válido." },
      { status: 400 },
    );
  }
  const { declaredCashCents } = parsed.data;

  const shift = await getCurrentMeseroShift(userId);
  if (!shift) {
    return NextResponse.json(
      { error: "no_open_shift", message: "No tienes turno abierto." },
      { status: 400 },
    );
  }

  const now = new Date();

  // Resumen: todo lo cobrado durante el turno.
  const payments = await db.payment.findMany({
    where: {
      collectedByUserId: userId,
      status: "approved",
      settledAt: { gte: shift.openedAt, lte: now },
    },
    select: {
      amountCents: true,
      tipCents: true,
      method: true,
      orderId: true,
      order: { select: { tableId: true } },
    },
  });

  const tipsCents = payments.reduce((s, p) => s + p.tipCents, 0);
  const salesCents = payments.reduce(
    (s, p) => s + (p.amountCents - p.tipCents),
    0,
  );
  // Solo el efectivo entra al arqueo de la caja del mesero. Tarjeta /
  // datáfono no pasan por su cajón.
  const cashCollectedCents = payments.reduce(
    (s, p) => (isCashMethod(p.method) ? s + p.amountCents : s),
    0,
  );
  const expectedCashCents = shift.openingCashCents + cashCollectedCents;
  const cashDiffCents = declaredCashCents - expectedCashCents;
  const tableSet = new Set<string>();
  for (const p of payments) if (p.order?.tableId) tableSet.add(p.order.tableId);
  const durationMs = now.getTime() - shift.openedAt.getTime();

  await db.shift.update({
    where: { id: shift.id },
    data: {
      status: "closed",
      closedAt: now,
      closedById: userId,
      declaredCashCents,
      expectedCashCents,
      cashDiffCents,
    },
  });

  publishOrderEvent(shift.restaurantId, { type: "cash.updated" });
  return NextResponse.json({
    ok: true,
    summary: {
      shiftId: shift.id,
      openedAtIso: shift.openedAt.toISOString(),
      closedAtIso: now.toISOString(),
      durationMs,
      tipsCents,
      salesCents,
      paymentCount: payments.length,
      tableCount: tableSet.size,
      openingCashCents: shift.openingCashCents,
      cashCollectedCents,
      expectedCashCents,
      declaredCashCents,
      cashDiffCents,
    },
  });
}
