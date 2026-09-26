import { createHash } from "node:crypto";
import { auth } from "@/auth";
import { announceBillRequestedOnPay } from "@/lib/billRequest";
import { DEMO_PAYMENTS_DISABLED, shouldBlockDemoPayment } from "@/lib/demoPayments";
import { sendPushToMeserosForTable } from "@/lib/push";
import { issueInvoiceOnPaid } from "@/lib/invoiceOnPaid";
import { isChargeBlockedForRole } from "@/lib/chargeControl";
import { chargeBlockedResponse } from "@/lib/chargeGuard";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { staffForRestaurant, COLLECTOR_ROLES } from "@/lib/staffAccess";
import { amountCentsSchema, tipCentsSchema, validPaymentAmounts } from "@/lib/payments/validation";
import { lockOrder } from "@/lib/orderLock";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { notifyAutoFiredTickets } from "@/lib/kds/autoFireTickets";
import { publishOrderEvent } from "@/lib/events";
import { meseroNeedsShiftToCharge } from "@/lib/meseroShift";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { CASH_METHOD, isCashMethod } from "@/lib/payments/methods";
import { prepareStaffCharge } from "@/lib/payments/staffCharge";

const schema = z.object({
  orderId: z.string().min(1),
  // Efectivo = "cash". "demo_cash" se sigue aceptando porque así lo manda
  // el front anterior (PWAs con el bundle viejo en caché): es el mismo
  // efectivo real y se graba como "cash".
  method: z.enum(["demo_card", "demo_nequi", "cash", "demo_cash"]),
  amountCents: amountCentsSchema,
  tipCents: tipCentsSchema,
  cashTenderCents: z.number().int().min(0).max(2_000_000_000).optional(),
  changeGivenCents: z.number().int().min(0).max(2_000_000_000).optional(),
  settleNow: z.boolean().optional(),
}).refine(validPaymentAmounts, { message: "invalid_amount" });

async function POSTHandler(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const staffRole = tenant.adminOnlyCharge ? (await auth())?.user?.role : null;
  if (isChargeBlockedForRole(staffRole, tenant.adminOnlyCharge)) return chargeBlockedResponse();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  const input = parsed.data;
  if (shouldBlockDemoPayment(input.method)) return NextResponse.json({ error: DEMO_PAYMENTS_DISABLED }, { status: 403 });
  const staff = input.settleNow ? await staffForRestaurant(tenant.id, COLLECTOR_ROLES) : null;
  if (input.settleNow && !staff) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (staff && await meseroNeedsShiftToCharge(staff.user.id, staff.user.role, tenant.id)) return NextResponse.json({ error: "mesero_no_shift" }, { status: 409 });
  const order = await db.order.findFirst({ where: { id: input.orderId, restaurantId: tenant.id } });
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const isCash = isCashMethod(input.method);
  let amountCents = input.amountCents;
  let tipCents = input.tipCents;
  if (staff && isCash && input.cashTenderCents != null && input.changeGivenCents != null) {
    const net = input.cashTenderCents - input.changeGivenCents;
    if (net < amountCents) return NextResponse.json({ error: "insufficient_cash" }, { status: 400 });
    tipCents += net - amountCents;
    amountCents = net;
  }
  const retryKey = req.headers.get("idempotency-key");
  const requestKey = retryKey ? createHash("sha256").update(`cash:${order.id}:${retryKey}`).digest("hex") : undefined;
  const approved = !isCash || !!staff;
  const result = await db.$transaction(async tx => {
    await lockOrder(tx, order.id);
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
    if (requestKey) {
      const existing = await tx.payment.findUnique({ where: { requestKey } });
      if (existing) {
        if (existing.amountCents !== amountCents || existing.tipCents !== tipCents) throw new Error("operation_conflict");
        return { payment: existing, paid: current.status === "paid", fired: [] };
      }
    }
    if (["paid", "cancelled"].includes(current.status)) throw new Error("order_closed");
    // El staff que cobra reemplaza las SOLICITUDES del comensal (efectivo o
    // datáfono propio pendientes: no hay plata en vuelo). Los pagos en línea
    // en curso siguen reservados; si son lo único que impide este cobro, sale
    // un 409 `pending_payment_in_flight` que dice cuál es (staffCharge.ts).
    if (staff) await prepareStaffCharge(tx, order.id, amountCents - tipCents);
    const payment = await tx.payment.create({ data: {
      requestKey, orderId: order.id, method: isCash ? CASH_METHOD : input.method === "demo_nequi" ? "wompi_nequi" : input.method,
      status: approved ? "approved" : "pending", amountCents, tipCents,
      cashTenderCents: input.cashTenderCents, settledAt: approved ? new Date() : null,
      collectedByUserId: staff?.user.id,
    } });
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    const fired = totals.fullyPaid ? await activateOpenRounds(tx, order.id) : [];
    return { payment, paid: totals.fullyPaid, fired };
  });
  publishOrderEvent(tenant.id, { type: result.paid ? "order.paid" : "order.updated", orderId: order.id });
  // Rondas prepagas recién activadas y marchadas solas: la comanda sale ahora, fuera de la tx.
  await notifyAutoFiredTickets({ restaurantId: tenant.id, orderId: order.id, rounds: result.fired });
  if (!approved) publishOrderEvent(tenant.id, { type: "order.cash_requested", orderId: order.id, paymentId: result.payment.id });
  if (result.paid && order.dinerId) void welcomeIfFirstTime(order.dinerId, order.locale).catch(err => console.error("welcome_failed", err));
  if (result.paid) await issueInvoiceOnPaid({ tenantId: tenant.id, orderId: order.id });
  if (!approved) {
    void (async () => {
      const table = order.tableId ? await db.table.findUnique({ where: { id: order.tableId }, select: { number: true, label: true } }) : null;
      if (!table || table.number < 0) return;
      await sendPushToMeserosForTable(tenant.id, table.number, {
        title: `${table.label ?? `Mesa ${table.number}`} pidió cobrar`,
        body: `Pago en efectivo · ${(amountCents / 100).toLocaleString("es-CO")} COP`,
        tag: `cash-${order.id}`, url: "/mesero/salon",
      });
    })().catch(() => console.error("push_cash_failed"));
    await announceBillRequestedOnPay({ tenant, order, role: staffRole, method: "cash" });
  }
  return NextResponse.json({ paymentId: result.payment.id, paid: result.paid, pending: !approved });
}
export const POST = secureApi(POSTHandler);
