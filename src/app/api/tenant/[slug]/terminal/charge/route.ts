import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { ensureMockBridge } from "@/lib/payments/mockBridge";

/**
 * Push a pending datáfono Payment to a Kushki Smart POS terminal.
 *
 * Called from the /terminal grid when the operator taps "Cobrar". The
 * payment row is already in pending state (created by /pay/terminal-request
 * when the diner tapped the button). We just hand the amount to the
 * device and wait for the webhook callback to settle it.
 *
 * Auth: any role that has access to the restaurant. terminal role is the
 * primary user; operator/platform_admin can also drive it for support.
 */

const schema = z.object({
  paymentId: z.string().min(1),
  deviceId: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const role = session.user.role;
  if (role !== "terminal" && role !== "operator" && role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Ensure the mock-webhook bridge is wired up so the simulated terminal
  // response feeds back through the shared webhook processor.
  ensureMockBridge();

  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }
  if (
    role !== "platform_admin" &&
    session.user.restaurantId !== tenant.id
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const payment = await db.payment.findUnique({
    where: { id: parsed.data.paymentId },
    include: { order: true },
  });
  if (!payment || payment.order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (payment.method !== "kushki_card_terminal") {
    return NextResponse.json(
      { error: "wrong_method" },
      { status: 400 },
    );
  }
  if (payment.status !== "pending") {
    return NextResponse.json(
      { error: "already_settled" },
      { status: 409 },
    );
  }

  const device = await db.terminalDevice.findUnique({
    where: { kushkiDeviceId: parsed.data.deviceId },
  });
  if (!device || device.restaurantId !== tenant.id || !device.active) {
    return NextResponse.json({ error: "invalid_device" }, { status: 400 });
  }

  const privateKey = await getRestaurantPrivateKey(tenant.id);
  if (!privateKey) {
    return NextResponse.json(
      { error: "credentials_missing" },
      { status: 500 },
    );
  }

  let push;
  try {
    push = await getPaymentProvider().pushToTerminal({
      merchantId: privateKey,
      deviceId: parsed.data.deviceId,
      amount: {
        // payment.amountCents YA incluye la propina (TOTAL). Sumar
        // tipCents otra vez cobraba doble propina en el datáfono real.
        amountCents: payment.amountCents,
        currency: "COP",
      },
      metadata: {
        orderId: payment.orderId,
        paymentId: payment.id,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "push_failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      { status: 502 },
    );
  }

  // Record the provider ref now so the webhook can find this payment even
  // if it arrives before the operator's HTTP response.
  await db.payment.update({
    where: { id: payment.id },
    data: { providerRef: push.providerRef },
  });
  await db.terminalDevice.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date() },
  });

  return NextResponse.json({
    ok: true,
    providerRef: push.providerRef,
    status: push.status,
  });
}
