import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { welcomeIfFirstTime } from "@/lib/mailer";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";

/**
 * Apple Pay charge through Kushki.
 *
 * Frontend flow:
 *   1. Get tenant.kushkiPublicKey from page props.
 *   2. Kushki JS SDK opens the Apple Pay sheet, returns a token.
 *   3. POST { orderId, method, token, amountCents, tipCents } here.
 *   4. We charge via provider.chargeWithToken using the sub-merchant key.
 *   5. On approval, Payment becomes approved and the order recomputes.
 *
 * Google Pay isn't offered through Kushki Colombia, so the wallet path
 * is Apple-only. The method enum is restricted to kushki_apple_pay
 * below to make that explicit.
 *
 * In KUSHKI_MODE=mock the token can be any non-empty string — the mock
 * provider doesn't validate it, just returns approved/declined based on a
 * coin flip. That keeps the wizard testable end-to-end without real wallet
 * credentials.
 */

const schema = z.object({
  orderId: z.string().min(1),
  // Apple Pay is the only wallet method through this route — Kushki
  // Colombia doesn't offer Google Pay.
  method: z.enum(["kushki_apple_pay"]),
  token: z.string().min(1).max(2000),
  amountCents: z.number().int().min(100),
  tipCents: z.number().int().min(0).default(0),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  }
  if (!tenant.kushkiMerchantId) {
    return NextResponse.json(
      { error: "tenant_not_onboarded" },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const order = await db.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order not found" }, { status: 404 });
  }

  // Pre-create the payment row so we can reference it from logs/webhooks even
  // if the provider call fails. Status starts pending; we flip it after the
  // provider replies.
  const pendingPayment = await db.payment.create({
    data: {
      orderId: order.id,
      method: parsed.data.method,
      status: "pending",
      amountCents: parsed.data.amountCents,
      tipCents: parsed.data.tipCents,
    },
  });

  const provider = getPaymentProvider();
  const privateKey = await getRestaurantPrivateKey(tenant.id);
  if (!privateKey) {
    await db.payment.update({
      where: { id: pendingPayment.id },
      data: { status: "declined" },
    });
    return NextResponse.json(
      { error: "credentials_missing" },
      { status: 500 },
    );
  }

  let charge;
  try {
    charge = await provider.chargeWithToken({
      // For Kushki, the per-merchant private key is what authenticates the
      // charge; we pass it where the interface asks for merchantId.
      merchantId: privateKey,
      amount: { amountCents: parsed.data.amountCents, currency: "COP" },
      token: parsed.data.token,
      metadata: {
        orderId: order.id,
        paymentId: pendingPayment.id,
        tableId: order.tableId,
      },
    });
  } catch (err) {
    await db.payment.update({
      where: { id: pendingPayment.id },
      data: { status: "declined" },
    });
    publishOrderEvent(tenant.id, {
      type: "payment.declined",
      orderId: order.id,
      paymentId: pendingPayment.id,
      reason: err instanceof Error ? err.message : "provider_error",
    });
    return NextResponse.json(
      { error: "charge_failed" },
      { status: 502 },
    );
  }

  // Persist the provider reference + KushkiTransaction mirror regardless of
  // outcome so we can audit declined attempts.
  await db.kushkiTransaction.create({
    data: {
      restaurantId: tenant.id,
      paymentId: pendingPayment.id,
      kushkiTxId: charge.providerRef,
      kind: "charge",
      status: charge.status === "approved" ? "approved" : "declined",
      amountCents: parsed.data.amountCents,
      raw: charge.raw as object,
      message: charge.message,
    },
  });

  if (charge.status !== "approved") {
    await db.payment.update({
      where: { id: pendingPayment.id },
      data: { status: "declined", providerRef: charge.providerRef },
    });
    publishOrderEvent(tenant.id, {
      type: "payment.declined",
      orderId: order.id,
      paymentId: pendingPayment.id,
      reason: charge.message ?? "declined",
    });
    return NextResponse.json({
      paymentId: pendingPayment.id,
      approved: false,
      message: charge.message ?? "Pago rechazado",
    });
  }

  // Approved: flip payment, recompute order, release rounds if fully paid.
  const result = await db.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: pendingPayment.id },
      data: {
        status: "approved",
        providerRef: charge.providerRef,
        settledAt: new Date(),
      },
    });
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    if (totals.fullyPaid) {
      await activateOpenRounds(tx, order.id);
    }
    return { fullyPaid: totals.fullyPaid };
  });

  publishOrderEvent(tenant.id, {
    type: "payment.approved",
    orderId: order.id,
    paymentId: pendingPayment.id,
  });
  publishOrderEvent(tenant.id, {
    type: result.fullyPaid ? "order.paid" : "order.updated",
    orderId: order.id,
  });

  if (result.fullyPaid && order.customerId) {
    welcomeIfFirstTime(order.customerId).catch((err) =>
      console.error("[welcomeIfFirstTime]", err),
    );
  }

  return NextResponse.json({
    paymentId: pendingPayment.id,
    approved: true,
    paid: result.fullyPaid,
  });
}
