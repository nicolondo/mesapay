import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { staffForRestaurant, COLLECTOR_ROLES } from "@/lib/staffAccess";
import { demoPaymentsAllowed, amountCentsSchema, tipCentsSchema, validPaymentAmounts } from "@/lib/payments/validation";
import { lockOrder } from "@/lib/orderLock";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { publishOrderEvent } from "@/lib/events";
import { meseroNeedsShiftToCharge } from "@/lib/meseroShift";
import { welcomeIfFirstTime } from "@/lib/mailer";

const schema = z.object({
  orderId: z.string().min(1),
  method: z.enum(["demo_card", "demo_cash", "demo_nequi"]),
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
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_amount" }, { status: 400 });
  const input = parsed.data;
  if (input.method !== "demo_cash" && !demoPaymentsAllowed()) return NextResponse.json({ error: "payment_method_disabled" }, { status: 403 });
  const staff = input.settleNow ? await staffForRestaurant(tenant.id, COLLECTOR_ROLES) : null;
  if (input.settleNow && !staff) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (staff && await meseroNeedsShiftToCharge(staff.user.id, staff.user.role, tenant.id)) return NextResponse.json({ error: "mesero_no_shift" }, { status: 409 });
  const order = await db.order.findFirst({ where: { id: input.orderId, restaurantId: tenant.id } });
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let amountCents = input.amountCents;
  let tipCents = input.tipCents;
  if (input.cashTenderCents != null && input.changeGivenCents != null) {
    const net = input.cashTenderCents - input.changeGivenCents;
    if (net < amountCents) return NextResponse.json({ error: "insufficient_cash" }, { status: 400 });
    tipCents += net - amountCents;
    amountCents = net;
  }
  const approved = input.method !== "demo_cash" || !!staff;
  const result = await db.$transaction(async tx => {
    await lockOrder(tx, order.id);
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
    if (["paid", "cancelled"].includes(current.status)) throw new Error("order_closed");
    // Only a collector can replace cash requests. Financial attempts stay reserved.
    if (staff) await tx.payment.updateMany({ where: { orderId: order.id, method: "demo_cash", status: "pending" }, data: { status: "declined" } });
    const payment = await tx.payment.create({ data: {
      orderId: order.id, method: input.method === "demo_nequi" ? "wompi_nequi" : input.method,
      status: approved ? "approved" : "pending", amountCents, tipCents,
      cashTenderCents: input.cashTenderCents, settledAt: approved ? new Date() : null,
      collectedByUserId: staff?.user.id,
    } });
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    if (totals.fullyPaid) await activateOpenRounds(tx, order.id);
    return { payment, paid: totals.fullyPaid };
  });
  publishOrderEvent(tenant.id, { type: result.paid ? "order.paid" : "order.updated", orderId: order.id });
  if (!approved) publishOrderEvent(tenant.id, { type: "order.cash_requested", orderId: order.id, paymentId: result.payment.id });
  if (result.paid && order.customerId) void welcomeIfFirstTime(order.customerId, order.locale).catch(err => console.error("welcome_failed", err));
  return NextResponse.json({ paymentId: result.payment.id, paid: result.paid, pending: !approved });
}
export const POST = secureApi(POSTHandler);
