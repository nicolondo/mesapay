import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getCurrentMeseroShift } from "@/lib/meseroShift";

/**
 * Cierra el turno personal abierto del mesero. Calcula y devuelve el
 * resumen (propinas, ventas, mesas atendidas, duración) para que la
 * UI muestre un summary modal al cerrar.
 *
 * No pedimos arqueo de caja como en el shift global — el mesero no
 * tiene un drawer propio. Sus pagos en efectivo van al pool del
 * restaurante (cuyo arqueo lo hace el operador).
 */
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "mesero") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const userId = session.user.id;

  const shift = await getCurrentMeseroShift(userId);
  if (!shift) {
    // El que llama es el propio mesero — su cookie de idioma aplica.
    const t = await getTranslations("meseroYo");
    return NextResponse.json(
      { error: "no_open_shift", message: t("apiNoOpenShift") },
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
      orderId: true,
      order: { select: { tableId: true } },
    },
  });

  const tipsCents = payments.reduce((s, p) => s + p.tipCents, 0);
  const salesCents = payments.reduce(
    (s, p) => s + (p.amountCents - p.tipCents),
    0,
  );
  const tableSet = new Set<string>();
  for (const p of payments) if (p.order?.tableId) tableSet.add(p.order.tableId);
  const durationMs = now.getTime() - shift.openedAt.getTime();

  await db.shift.update({
    where: { id: shift.id },
    data: {
      status: "closed",
      closedAt: now,
      closedById: userId,
      // Arqueo no aplica para shift personal — dejamos null para no
      // ensuciar el modelo del shift global del restaurante.
      declaredCashCents: null,
      expectedCashCents: null,
      cashDiffCents: null,
    },
  });

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
    },
  });
}
