import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { meseroNeedsShiftToCharge } from "@/lib/meseroShift";

export const dynamic = "force-dynamic";

/**
 * Cerrar una cuenta como CORTESÍA / gastos de representación (ERP A3): sin
 * cobro. Los ítems vivos se marcan `comp` (consumen inventario, no venden) y
 * la orden se cierra en $0. Se guarda una nota de a quién se le dio + el valor
 * de venta regalado, para auditoría/reporte.
 *
 * Solo desde sesión staff (operator/mesero/platform_admin) y — como el cobro
 * en efectivo — el mesero necesita turno abierto (arqueo). Requiere que el
 * comercio tenga la función habilitada (Restaurant.compEnabled).
 */
const schema = z.object({
  // A quién se le dio (obligatorio, es el registro de la cortesía).
  note: z.string().trim().min(1).max(300),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true, compEnabled: true, compLabel: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }
  if (!tenant.compEnabled) {
    return NextResponse.json({ error: "comp_disabled" }, { status: 403 });
  }

  const session = await auth();
  const role = session?.user?.role;
  const staff =
    !!session?.user &&
    (role === "operator" || role === "mesero" || role === "platform_admin");
  if (!staff) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { id: true, restaurantId: true, status: true, compedAt: true },
  });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (order.status === "paid" || order.compedAt) {
    return NextResponse.json({ error: "already_closed" }, { status: 409 });
  }

  // Mismo guardarraíl que el cobro: el mesero sin turno abierto descuadra el
  // arqueo; se bloquea y el front ofrece abrir turno.
  if (await meseroNeedsShiftToCharge(session!.user.id, role!, tenant.id)) {
    return NextResponse.json(
      { error: "mesero_no_shift", message: "No tenés turno abierto." },
      { status: 409 },
    );
  }

  const label = tenant.compLabel?.trim() || "Gastos de representación";

  const result = await db.$transaction(async (tx) => {
    // Ítems vivos = no cancelados y en rounds no cancelados. Valor de venta
    // regalado = Σ precio (para el registro; luego el subtotal queda en 0).
    const items = await tx.orderItem.findMany({
      where: {
        orderId: order.id,
        cancelledAt: null,
        OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
      },
      select: { id: true, qty: true, priceCentsSnapshot: true },
    });
    const compAmountCents = items.reduce(
      (s, i) => s + i.priceCentsSnapshot * i.qty,
      0,
    );
    const now = new Date();
    // Barrer pendings en vuelo (datáfono/efectivo sin confirmar): la cuenta
    // se cierra como cortesía, esos intentos quedan obsoletos.
    await tx.payment.updateMany({
      where: { orderId: order.id, status: "pending" },
      data: { status: "declined" },
    });
    // Marcar los ítems como comp: consumen inventario (se prepararon) pero
    // NO venden — reusa la exclusión de ventas existente en contabilidad.
    if (items.length > 0) {
      await tx.orderItem.updateMany({
        where: { id: { in: items.map((i) => i.id) } },
        data: {
          cancelledAt: now,
          cancellationKind: "comp",
          cancellationReason: `${label}: ${parsed.data.note}`,
          cancelledByEmail: session!.user.email ?? null,
        },
      });
    }
    // Cuenta en $0 + registro de la cortesía. Se pone subtotal 0 ANTES del
    // recompute para que la orden quede fullyPaid (0 ≥ 0) → paid.
    await tx.order.update({
      where: { id: order.id },
      data: {
        subtotalCents: 0,
        compedAt: now,
        compNote: parsed.data.note,
        compLabel: label,
        compAmountCents,
      },
    });
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    if (totals.fullyPaid) {
      await activateOpenRounds(tx, order.id);
    }
    return { fullyPaid: totals.fullyPaid, compAmountCents };
  });

  // Dispara el consumo de inventario (los ítems comp consumen) + cierra la
  // mesa en los tableros.
  publishOrderEvent(tenant.id, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: order.id,
  });

  return NextResponse.json({
    ok: true,
    compAmountCents: result.compAmountCents,
  });
}
