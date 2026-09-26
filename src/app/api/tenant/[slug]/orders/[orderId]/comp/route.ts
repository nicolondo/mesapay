import { secureApi } from "@/lib/secureApi";
import { staffForRestaurant, COLLECTOR_ROLES } from "@/lib/staffAccess";
import { lockOrder } from "@/lib/orderLock";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { notifyAutoFiredTickets } from "@/lib/kds/autoFireTickets";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { issueInvoiceOnPaid } from "@/lib/invoiceOnPaid";
import { meseroNeedsShiftToCharge } from "@/lib/meseroShift";
import { isChargeBlockedForRole } from "@/lib/chargeControl";
import { chargeBlockedResponse } from "@/lib/chargeGuard";
import { canCompOrders } from "@/lib/staffPolicies";
import { compBlockedResponse } from "@/lib/compGuard";
import { recordAuditEvent } from "@/lib/auditLog";
import { assertNoPaymentInFlightHolding, releasePaymentRequests } from "@/lib/payments/staffCharge";

export const dynamic = "force-dynamic";

/**
 * Cerrar una cuenta como CORTESÍA / gastos de representación (ERP A3): sin
 * cobro. Los ítems vivos se marcan `comp` (consumen inventario, no venden) y
 * la orden se cierra en $0. Se guarda una nota de a quién se le dio + el valor
 * de venta regalado, para auditoría/reporte.
 *
 * Solo desde sesión staff (operator/mesero/platform_admin) y — como el cobro
 * en efectivo — el mesero necesita turno abierto (arqueo). Requiere que el
 * comercio tenga la función habilitada (Restaurant.compEnabled) y que el
 * rol esté entre los que pueden no cobrar (Restaurant.compAllowedRoles,
 * misma política que "No cobrar" un plato — ver src/lib/compGuard.ts).
 */
const schema = z.object({
  // A quién se le dio (obligatorio, es el registro de la cortesía).
  note: z.string().trim().min(1).max(300),
});

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: {
      id: true,
      compEnabled: true,
      compLabel: true,
      adminOnlyCharge: true,
      compAllowedRoles: true,
    },
  });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }
  if (!tenant.compEnabled) {
    return NextResponse.json({ error: "comp_disabled" }, { status: 403 });
  }

  const session = await staffForRestaurant(tenant.id, COLLECTOR_ROLES);
  const role = session?.user?.role;
  const staff =
    !!session?.user &&
    (role === "operator" || role === "mesero" || role === "platform_admin");
  if (!staff) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // Control de caja: cerrar una cuenta como cortesía es cerrar una cuenta
  // sin cobrarla — la vía más barata de saltarse "solo el administrador
  // cobra". Va bajo el mismo guardarraíl (igual que el turno abierto, acá
  // abajo, que este endpoint ya compartía con el cobro).
  if (isChargeBlockedForRole(role, tenant.adminOnlyCharge)) {
    return chargeBlockedResponse();
  }
  // Sólo los roles que el comercio eligió pueden cerrar una cuenta sin
  // cobrarla (default: sólo el administrador). La pantalla de cobro ya
  // esconde el botón (PayFlow), pero la API se defiende sola.
  if (!canCompOrders(role, tenant.compAllowedRoles)) {
    return compBlockedResponse();
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
    await lockOrder(tx, order.id);
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
    if (["paid", "cancelled"].includes(current.status)) return null;
    // Una cuenta con algo ya cobrado no se regala.
    const approved = await tx.payment.count({ where: { orderId: order.id, status: "approved" } });
    if (approved) return null;
    // Un pago en línea en curso tampoco: quizá ya se cobró. 409
    // pending_payment_in_flight con cuál es (se revierte la transacción).
    await assertNoPaymentInFlightHolding(tx, order.id);
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
    // Las solicitudes del comensal ("voy a pagar en efectivo", "tráiganme
    // el datáfono") quedan obsoletas: la cuenta se cierra como cortesía.
    // Son los únicos pendientes que pueden quedar a esta altura.
    await releasePaymentRequests(tx, order.id);
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
        taxCents: 0,
        compedAt: now,
        compNote: parsed.data.note,
        compLabel: label,
        compAmountCents,
      },
    });
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    // Una cortesía también "paga" la cuenta: activa rondas prepagas y, si
    // la estación marcha sola, `fired` trae qué imprimir después de la tx.
    const fired = totals.fullyPaid
      ? await activateOpenRounds(tx, order.id)
      : [];
    return { fullyPaid: totals.fullyPaid, compAmountCents, fired };
  });

  if (!result) return NextResponse.json({ error: "order_closed_or_payment_pending" }, { status: 409 });

  // Auditoría: quién (usuario + rol, los pone el helper desde la sesión),
  // cuánto se regaló y a quién. Es lo que el dueño ve en /admin/audit para
  // controlar el "no cobrar", igual que con el plato suelto.
  await recordAuditEvent({
    kind: "order.comp",
    restaurantId: tenant.id,
    target: { type: "order", id: order.id },
    summary: `No cobró la cuenta (${label}) — ${parsed.data.note}`,
    diff: {
      after: {
        compAmountCents: result.compAmountCents,
        label,
        note: parsed.data.note,
      },
    },
  });

  // Dispara el consumo de inventario (los ítems comp consumen) + cierra la
  // mesa en los tableros.
  publishOrderEvent(tenant.id, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: order.id,
  });
  await notifyAutoFiredTickets({
    restaurantId: tenant.id,
    orderId: order.id,
    rounds: result.fired,
  });

  // La cortesía cierra la cuenta en $0: sigue siendo una cuenta pagada y, si
  // alguien pidió comprobante, hay que emitirlo igual. NO es una venta: el
  // helper no la factura sola ni la manda a la DIAN (ver isBillableOrder).
  if (result.fullyPaid) {
    await issueInvoiceOnPaid({
      tenantId: tenant.id,
      orderId: order.id,
    });
  }

  return NextResponse.json({
    ok: true,
    compAmountCents: result.compAmountCents,
  });
}

export const POST = secureApi(POSTHandler);
