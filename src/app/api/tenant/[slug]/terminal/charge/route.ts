import { randomUUID } from "node:crypto";
import { lockOrder } from "@/lib/orderLock";
import { markPaymentUncertain } from "@/lib/payments/intent";
import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { getPaymentProvider } from "@/lib/payments";
import { ensureMockBridge } from "@/lib/payments/mockBridge";
import {
  pushPaymentToCloudTerminal,
  terminalAnswerCode,
  type CloudTerminalChargeResult,
} from "@/lib/payments/kushki/cloudTerminal";
import { publishOrderEvent } from "@/lib/events";
import { recoverTerminalOutcome } from "@/lib/payments/terminalRecovery";
import { processKushkiWebhook } from "@/lib/payments/webhookHandler";
import { kushkiTerminalSetup, terminalDeviceUsable } from "@/lib/payments/terminalAvailability";
import { terminalClaimKey } from "@/lib/payments/methods";
import { isChargeBlockedForRole } from "@/lib/chargeControl";
import { chargeBlockedResponse } from "@/lib/chargeGuard";

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

/**
 * Lo que contestó el datáfono cuando NO aprobó, en el reclamo
 * `terminal:<id>`. Con eso las pantallas saben que el cobro síncrono ya
 * terminó (el staff puede reintentar o cancelar sin esperar) y la del
 * comensal, que se canceló en el equipo. Antes de settlear: si el rechazo
 * después falla, el pago queda incierto pero con la respuesta guardada.
 */
async function recordTerminalAnswer(paymentId: string, result: CloudTerminalChargeResult) {
  await db.financialOperation.updateMany({
    where: { key: terminalClaimKey(paymentId), answeredAt: null },
    data: {
      answerCode: terminalAnswerCode(result.failure),
      answerMessage: result.failure?.message?.slice(0, 300) ?? null,
      answeredAt: new Date(),
      providerRef: result.providerRef,
    },
  });
}

/**
 * El cobro terminó sin aprobarse ni liberarse: no se sabe si el equipo cobró
 * (o contestó algo que no es definitivo). El pago queda incierto y la cuenta
 * bloqueada; las pantallas se actualizan para mostrar qué se puede hacer.
 */
async function leaveUncertain(restaurantId: string, payment: { id: string; orderId: string }) {
  await markPaymentUncertain(payment.id);
  publishOrderEvent(restaurantId, { type: "order.updated", orderId: payment.orderId });
}

async function POSTHandler(
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
  // Control de caja: mandar el monto al datáfono ES iniciar el cobro. Con
  // "solo el administrador cobra" el mesero no puede, aunque tenga el
  // equipo en la mano. El rol `terminal` (la caja) sigue pudiendo.
  if (isChargeBlockedForRole(role, tenant.adminOnlyCharge)) {
    return chargeBlockedResponse();
  }
  // ¿Vamos al datáfono REAL (Cloud Terminal, cloudt) o al mock?
  //  - En sandbox/producción → real.
  //  - "Desacoplado": si el comercio cargó su Business-Code, usamos el
  //    datáfono real aunque el resto de Kushki siga en mock.
  // El Business-Code es la CLAVE HMAC con la que se firma el cobro: sin él
  // no podemos autenticar contra cloudt.
  // Modo EFECTIVO del comercio (override propio o global). Define el host
  // del datáfono: sandbox → uat-cloudt, production → cloudt.
  // (Mismas reglas que `kushkiTerminalAvailability`, que usa
  // terminal-request para no crear solicitudes imposibles de empujar.)
  const { mode, businessCode, useRealTerminal } = await kushkiTerminalSetup(tenant);
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

  if (!terminalDeviceUsable(device, useRealTerminal)) return NextResponse.json({ error: "device_no_serial" }, { status: 400 });
  if (!useRealTerminal && process.env.NODE_ENV === "production") return NextResponse.json({ error: "mock_payments_disabled" }, { status: 409 });
  // El reclamo `terminal:<id>` se crea bajo `lockOrder` y DESPUÉS de
  // re-verificar que el pago sigue pendiente: es lo que lo convierte de
  // solicitud (reemplazable por el cobro del staff o "Cancelar solicitud")
  // en cobro en vuelo. Si el staff lo declinó mientras tanto, esto rebota
  // con operation_conflict y no se llama a Kushki.
  // `client_transaction_id` del cobro, guardado en el reclamo ANTES de
  // llamar a Kushki: si la respuesta no llega, con él se busca el resultado.
  const clientTransactionId = randomUUID();
  const pushedAt = new Date();
  const claimed = await db.$transaction(async tx => {
    await lockOrder(tx, payment.orderId);
    const current = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, include: { order: true } });
    if (current.status !== "pending" || current.order.status === "cancelled") throw new Error("operation_conflict");
    // `deviceId`: a qué equipo va (para «Reintentar en el datáfono» y para
    // pedirle que cancele un cobro en curso).
    const result = await tx.financialOperation.createMany({ data: [{ key: terminalClaimKey(payment.id), paymentId: payment.id, kind: "terminal", amountCents: payment.amountCents, deviceId: device.kushkiDeviceId, clientTransactionId, createdAt: pushedAt }], skipDuplicates: true });
    return result.count === 1;
  });
  if (!claimed) return NextResponse.json({ pending: true, error: "payment_pending" }, { status: 202 });

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
    const serialNumber = device.serialNumber;
    /**
     * No llegó la respuesta del cobro (504 del gateway de Kushki a los 60 s,
     * timeout, red, 5xx): el datáfono puede seguir esperando la tarjeta. Se
     * busca el resultado real en Kushki hasta que el equipo ya no pueda
     * responder (ver terminalRecovery.ts). Aprobado → se salda como siempre
     * (factura e impresión incluidas); rechazado → cuenta libre; nada →
     * incierto como hasta hoy.
     */
    const noAnswer = async () => {
      const recovered = await recoverTerminalOutcome({
        restaurantId: tenant.id,
        paymentId: payment.id,
        amountCents: payment.amountCents,
        serialNumber,
        clientTransactionId,
        businessCode,
        mode,
        pushedAt,
      });
      if (recovered.status === "approved") {
        return NextResponse.json({ ok: true, status: "approved", providerRef: recovered.providerRef, recovered: true });
      }
      if (recovered.status === "declined") {
        return NextResponse.json({ ok: false, status: "declined", recovered: true }, { status: 402 });
      }
      await leaveUncertain(tenant.id, payment);
      return NextResponse.json({ pending: true, error: "payment_pending" }, { status: 202 });
    };

    let result;
    try {
      result = await pushPaymentToCloudTerminal({
        serialNumber,
        // amountCents YA incluye la propina (TOTAL).
        amountCents: payment.amountCents,
        reference: payment.id,
        description: `MESAPAY orden ${payment.orderId.slice(0, 6)}`,
        // Business-Code del comercio (clave HMAC), cargado en Config →
        // Datáfonos (fallback al env de plataforma).
        businessCode,
        // Host del Cloud Terminal según el modo efectivo del comercio.
        mode,
        clientTransactionId,
      });
    } catch {
      return noAnswer();
    }


    if (result.status === "approved") {
      const processed = await processKushkiWebhook({
        eventId: `cloudterm:${payment.id}:ok`,
        type: "terminal.approved",
        restaurantId: tenant.id,
        paymentId: payment.id,
        providerRef: result.providerRef,
        message: result.message,
        raw: result.raw,
      });
      if (processed.status === "error") {
        await leaveUncertain(tenant.id, payment);
        return NextResponse.json({ pending: true, error: "payment_pending" }, { status: 202 });
      }
      return NextResponse.json({
        ok: true,
        status: "approved",
        providerRef: result.providerRef,
      });
    }

    if (result.status === "declined") {
      // Rechazo de tarjeta: marcamos el Payment como declined (no cobrado)
      // para que el mesero pueda reintentar / cambiar de método.
      const processed = await processKushkiWebhook({
        eventId: `cloudterm:${payment.id}:no:${Date.now()}`,
        type: "terminal.declined",
        restaurantId: tenant.id,
        paymentId: payment.id,
        providerRef: result.providerRef,
        message: result.message,
        raw: result.raw,
      });
      if (processed.status === "error") {
        await leaveUncertain(tenant.id, payment);
        return NextResponse.json({ pending: true, error: "payment_pending" }, { status: 202 });
      }
      return NextResponse.json(
        { ok: false, status: "declined", message: result.message },
        { status: 402 },
      );
    }

    if (result.status === "canceled") {
      // El datáfono dijo explícitamente que se canceló ANTES de autorizar
      // (TER-004 «User cancel the process», MAN-30005 lectura/PIN vencido):
      // no hubo cobro. Mismo camino que un rechazo del banco (pago declined,
      // reclamo `failed`, la cuenta sale de `paying` si no queda nada), con
      // su propio mensaje. Antes quedaba incierto y la cuenta trabada
      // (Son y Melona, 2026-11-04).
      await recordTerminalAnswer(payment.id, result);
      const processed = await processKushkiWebhook({
        eventId: `cloudterm:${payment.id}:canceled:${Date.now()}`,
        type: "terminal.declined",
        restaurantId: tenant.id,
        paymentId: payment.id,
        providerRef: result.providerRef,
        message: result.message,
        raw: result.raw,
      });
      if (processed.status === "error") {
        await leaveUncertain(tenant.id, payment);
        return NextResponse.json({ pending: true, error: "payment_pending" }, { status: 202 });
      }
      return NextResponse.json(
        { ok: false, status: "canceled", error: "terminal_canceled", message: result.message },
        { status: 402 },
      );
    }

    if (result.status === "rejected") {
      // Kushki NO validó la solicitud (4xx: Business-Code, serial, firma) y
      // nunca la mandó al equipo: no hubo cobro. Se declina por el mismo
      // camino que un rechazo del datáfono (el reclamo `terminal:<id>` queda
      // `failed` y la cuenta libre), en vez de dejarla incierta y trabada
      // (Son y Melona, 2026-10-31: 400 CLOUDPAYMENT_VALIDATION_ERROR).
      const processed = await processKushkiWebhook({
        eventId: `cloudterm:${payment.id}:rejected:${Date.now()}`,
        type: "terminal.declined",
        restaurantId: tenant.id,
        paymentId: payment.id,
        providerRef: result.providerRef,
        message: result.message,
        raw: result.raw,
      });
      if (processed.status === "error") {
        await leaveUncertain(tenant.id, payment);
        return NextResponse.json({ pending: true, error: "payment_pending" }, { status: 202 });
      }
      console.warn("[kushki/cloud-terminal] solicitud rechazada por validación", {
        paymentId: payment.id,
        httpStatus: result.httpStatus,
        code: result.failure?.code,
      });
      return NextResponse.json(
        {
          ok: false,
          status: "rejected",
          error: "terminal_request_rejected",
          // Lo que dijo Kushki, legible para quien revisa la configuración.
          kushki: {
            httpStatus: result.httpStatus ?? null,
            type: result.failure?.type ?? null,
            code: result.failure?.code ?? null,
            message: result.failure?.message ?? result.message ?? null,
          },
        },
        { status: 422 },
      );
    }

    // El equipo contestó que no aprobó, con un código que no es definitivo
    // (p. ej. TER-003, ocupado): el cobro síncrono terminó, así que el staff
    // puede reintentar o cancelar al instante (confirmando en la pantalla del
    // datáfono) en vez de esperar los 3 minutos de "Resolver cobro". Sigue
    // incierto hasta que alguien lo cierre.
    if (result.deviceAnswered) {
      await recordTerminalAnswer(payment.id, result);
      await leaveUncertain(tenant.id, payment);
      return NextResponse.json(
        { pending: true, error: "payment_pending", terminal: "answered" },
        { status: 202 },
      );
    }

    // Transport failure does not establish whether the terminal charged:
    // buscar el resultado real antes de dejarlo incierto.
    return noAnswer();
  }

  const currency = await getCurrencyForCountry(tenant.country);

  // —— Modo mock: el provider auto-aprueba vía el mock bridge (async).
  let push;
  try {
    const provider = await getPaymentProvider(mode);
    push = await provider.pushToTerminal({
      merchantId: "mock",
      deviceId: device.serialNumber ?? parsed.data.deviceId,
      amount: { amountCents: payment.amountCents, currency },
      metadata: { orderId: payment.orderId, paymentId: payment.id },
    });
  } catch {
      await leaveUncertain(tenant.id, payment);
      return NextResponse.json({ pending: true, error: "payment_pending" }, { status: 202 });
    }
  await db.payment.updateMany({
    where: { id: payment.id, status: "pending", providerRef: null },
    data: { providerRef: push.providerRef },
  });
  return NextResponse.json({
    ok: true,
    providerRef: push.providerRef,
    status: push.status,
  });
}

export const POST = secureApi(POSTHandler);
