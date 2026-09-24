import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { lockOrder } from "@/lib/orderLock";
import { publishOrderEvent } from "@/lib/events";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { notifyAutoFiredTickets } from "@/lib/kds/autoFireTickets";
import { computeOrderTotals, recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { issueInvoiceOnPaid } from "@/lib/invoiceOnPaid";
import { meseroNeedsShiftToCharge } from "@/lib/meseroShift";
import { isChargeBlocked, chargeBlockedResponse } from "@/lib/chargeGuard";
import { CASH_METHODS } from "@/lib/payments/methods";
import { canChargeOnCredit, loadCustomerCreditSummary } from "@/lib/customerCredit";
import { applyCustomerDiscount, type ApplyCustomerDiscountResult } from "@/lib/customerDiscount";

const schema = z.object({
  billingCustomerId: z.string().min(1).max(64),
  tipCents: z.number().int().min(0).max(100_000_000).optional(),
});

/**
 * Cobrar la cuenta A CRÉDITO a un cliente de facturación.
 *
 * Deja la cuenta pagada para la mesa y la cocina (mismo camino que
 * efectivo: Payment approved + recomputeOrderTotalsInTx → rondas, factura,
 * comisión) pero sin que entre plata: el pago lleva method=customer_credit
 * y billingCustomerId, y pasa a ser deuda del cliente (cuentas por cobrar)
 * hasta que abone. Se cobra TODO lo pendiente de la cuenta más la propina
 * que se anote; no hay crédito parcial.
 *
 * Guardias, en orden: rol de cobro, comercio activo, "solo el
 * administrador cobra", turno del mesero, cuenta abierta, cliente del
 * comercio con crédito habilitado y tope de crédito (deuda + esta cuenta),
 * todo bajo el lock de la orden y del cliente.
 */
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "group_admin" &&
      session.user.role !== "terminal" &&
      session.user.role !== "mesero")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const tipCents = parsed.data.tipCents ?? 0;

  const order = await db.order.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, status: true, dinerId: true, locale: true },
  });
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const activeId = await getActiveRestaurantId();
  if (order.restaurantId !== activeId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (await isChargeBlocked(session.user.role, order.restaurantId)) return chargeBlockedResponse();
  if (await meseroNeedsShiftToCharge(session.user.id, session.user.role, order.restaurantId)) {
    return NextResponse.json({ error: "mesero_no_shift" }, { status: 409 });
  }
  if (order.status === "paid" || order.status === "cancelled") {
    return NextResponse.json({ error: "order_closed" }, { status: 409 });
  }

  const customer = await db.billingCustomer.findFirst({
    where: { id: parsed.data.billingCustomerId, restaurantId: order.restaurantId },
    select: { id: true, creditEnabled: true, discountEnabled: true, discountBps: true },
  });
  if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  if (!customer.creditEnabled) return NextResponse.json({ error: "credit_disabled" }, { status: 409 });

  type TxResult =
    | { error: "order_closed" | "nothing_outstanding" | "credit_disabled" | "customer_not_found" }
    | { error: "credit_limit_exceeded"; debtCents: number; availableCents: number }
    | {
        paymentId: string;
        amountCents: number;
        fullyPaid: boolean;
        debtAfterCents: number;
        discount: ApplyCustomerDiscountResult;
        fired: Awaited<ReturnType<typeof activateOpenRounds>>;
      };

  const result = await db.$transaction(async (tx): Promise<TxResult> => {
    await lockOrder(tx, order.id);
    // Un "voy a pagar en efectivo" pendiente del comensal ya no aplica: el
    // staff está cerrando la cuenta a crédito (mismo barrido que el cobro
    // en efectivo con settleNow). Los pendientes de datáfono/PSE en vuelo
    // sí siguen reclamando su parte.
    await tx.payment.updateMany({
      where: { orderId: order.id, method: { in: [...CASH_METHODS] }, status: "pending" },
      data: { status: "declined" },
    });
    // Descuento comercial del cliente (si lo tiene) ANTES de calcular lo
    // pendiente: lo que se cobra a crédito es el neto. Idempotente y no pisa
    // un descuento mayor que ya tuviera la cuenta.
    const discount = await applyCustomerDiscount(tx, order.id, order.restaurantId, customer);
    const current = await tx.order.findUnique({
      where: { id: order.id },
      select: { status: true, subtotalCents: true, taxCents: true, discountCents: true },
    });
    if (!current || current.status === "paid" || current.status === "cancelled") {
      return { error: "order_closed" };
    }
    const claims = await tx.payment.findMany({
      where: { orderId: order.id, status: { in: ["approved", "pending"] } },
      select: { amountCents: true, tipCents: true },
    });
    const outstandingCents = computeOrderTotals(
      current.subtotalCents,
      claims,
      current.taxCents,
      current.discountCents,
    ).outstandingCents;
    if (outstandingCents <= 0) return { error: "nothing_outstanding" };

    // Deuda bajo el lock del cliente: dos mesas a la vez no pueden pasar
    // el tope entre las dos.
    await tx.$queryRaw`SELECT id FROM "BillingCustomer" WHERE id = ${customer.id} FOR UPDATE`;
    const summary = await loadCustomerCreditSummary(order.restaurantId, customer.id, tx);
    if (!summary) return { error: "customer_not_found" };
    const amountCents = outstandingCents + tipCents;
    const check = canChargeOnCredit({ customer: summary.customer, debtCents: summary.debtCents, amountCents });
    if (!check.ok) {
      if (check.error === "credit_limit_exceeded") {
        return { error: check.error, debtCents: summary.debtCents, availableCents: check.availableCents ?? 0 };
      }
      return { error: check.error };
    }

    const now = new Date();
    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        method: "customer_credit",
        status: "approved",
        amountCents,
        tipCents,
        billingCustomerId: customer.id,
        collectedByUserId: session.user.id,
        settledAt: now,
      },
    });
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    const fired = totals.fullyPaid ? await activateOpenRounds(tx, order.id) : [];
    return {
      paymentId: payment.id,
      amountCents,
      fullyPaid: totals.fullyPaid,
      debtAfterCents: summary.debtCents + amountCents,
      discount,
      fired,
    };
  });

  if ("error" in result) {
    const status = result.error === "customer_not_found" ? 404 : 409;
    return NextResponse.json(result, { status });
  }

  publishOrderEvent(order.restaurantId, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: order.id,
  });
  await notifyAutoFiredTickets({ restaurantId: order.restaurantId, orderId: order.id, rounds: result.fired });
  if (result.fullyPaid && order.dinerId) {
    welcomeIfFirstTime(order.dinerId, order.locale).catch((err) => console.error("[welcomeIfFirstTime]", err));
  }
  // La cuenta quedó cerrada: la factura (si se pidió, o si el comercio
  // factura todo) sale ahora, igual que con efectivo.
  if (result.fullyPaid) {
    await issueInvoiceOnPaid({ tenantId: order.restaurantId, orderId: order.id });
  }

  return NextResponse.json({
    ok: true,
    paid: result.fullyPaid,
    paymentId: result.paymentId,
    amountCents: result.amountCents,
    debtAfterCents: result.debtAfterCents,
    discount: result.discount,
  });
}

export const POST = secureApi(POSTHandler);
