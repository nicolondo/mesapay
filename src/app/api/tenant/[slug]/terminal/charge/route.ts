import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments";
import { ensureMockBridge } from "@/lib/payments/mockBridge";
import { pushPaymentToCloudTerminal } from "@/lib/payments/kushki/cloudTerminal";
import { processKushkiWebhook } from "@/lib/payments/webhookHandler";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { env } from "@/lib/env";

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
  // El mesero es el usuario principal del cobro por datáfono: lleva el
  // equipo a la mesa y presiona "Cobrar" desde el Salón. terminal/operator/
  // platform_admin también pueden. (Antes faltaba "mesero" → 403 forbidden.)
  if (
    role !== "mesero" &&
    role !== "terminal" &&
    role !== "operator" &&
    role !== "platform_admin"
  ) {
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
  // ¿Vamos al datáfono REAL (Cloud Terminal, cloudt) o al mock?
  //  - En sandbox/producción → real.
  //  - "Desacoplado": si el comercio cargó su Business-Code, usamos el
  //    datáfono real aunque el resto de Kushki siga en mock.
  // El Business-Code es la CLAVE HMAC con la que se firma el cobro: sin él
  // no podemos autenticar contra cloudt.
  // Modo EFECTIVO del comercio (override propio o global). Define el host
  // del datáfono: sandbox → uat-cloudt, production → cloudt.
  const mode = await getRestaurantKushkiMode(tenant);
  const businessCode =
    tenant.cloudTerminalBusinessCode || env.KUSHKI_BP_BUSINESS_CODE || null;
  const useRealTerminal = mode !== "mock" || !!businessCode;
  if (useRealTerminal && !businessCode) {
    return NextResponse.json(
      { error: "cloud_business_code_missing" },
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

  await db.terminalDevice.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date() },
  });

  if (useRealTerminal) {
    // —— Datáfono REAL vía Cloud Terminal SÍNCRONO
    // (POST /terminal/v1/{serial}/sync/charge). La request se queda
    // esperando hasta ~90s mientras el cliente pasa la tarjeta, y el
    // resultado (aprobada/rechazada) vuelve en la MISMA respuesta. No hay
    // webhook: settleamos acá mismo con el motor compartido.
    if (!device.serialNumber) {
      return NextResponse.json({ error: "device_no_serial" }, { status: 400 });
    }
    let result;
    try {
      result = await pushPaymentToCloudTerminal({
        serialNumber: device.serialNumber,
        // amountCents YA incluye la propina (TOTAL).
        amountCents: payment.amountCents,
        reference: payment.id,
        description: `MESAPAY orden ${payment.orderId.slice(0, 6)}`,
        // Business-Code del comercio (clave HMAC), cargado en Config →
        // Datáfonos (fallback al env de plataforma).
        businessCode,
        // Host del Cloud Terminal según el modo efectivo del comercio.
        mode,
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

    await db.payment.update({
      where: { id: payment.id },
      data: { providerRef: result.providerRef },
    });

    if (result.status === "approved") {
      await processKushkiWebhook({
        eventId: `cloudterm:${payment.id}:ok`,
        type: "terminal.approved",
        restaurantId: tenant.id,
        paymentId: payment.id,
        providerRef: result.providerRef,
        message: result.message,
        raw: result.raw,
      });
      return NextResponse.json({
        ok: true,
        status: "approved",
        providerRef: result.providerRef,
      });
    }

    if (result.status === "declined") {
      // Rechazo de tarjeta: marcamos el Payment como declined (no cobrado)
      // para que el mesero pueda reintentar / cambiar de método.
      await processKushkiWebhook({
        eventId: `cloudterm:${payment.id}:no:${Date.now()}`,
        type: "terminal.declined",
        restaurantId: tenant.id,
        paymentId: payment.id,
        providerRef: result.providerRef,
        message: result.message,
        raw: result.raw,
      });
      return NextResponse.json(
        { ok: false, status: "declined", message: result.message },
        { status: 402 },
      );
    }

    // status === "error": timeout / 5xx / red. NO cobrado, NO settle —
    // dejamos el Payment pending para reintentar.
    return NextResponse.json(
      { ok: false, status: "error", message: result.message },
      { status: 502 },
    );
  }

  // —— Modo mock: el provider auto-aprueba vía el mock bridge (async).
  let push;
  try {
    const provider = await getPaymentProvider(mode);
    push = await provider.pushToTerminal({
      merchantId: "mock",
      deviceId: device.serialNumber ?? parsed.data.deviceId,
      amount: { amountCents: payment.amountCents, currency: "COP" },
      metadata: { orderId: payment.orderId, paymentId: payment.id },
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
  await db.payment.update({
    where: { id: payment.id },
    data: { providerRef: push.providerRef },
  });
  return NextResponse.json({
    ok: true,
    providerRef: push.providerRef,
    status: push.status,
  });
}
