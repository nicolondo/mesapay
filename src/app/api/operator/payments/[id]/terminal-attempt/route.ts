import { z } from "zod";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";
import { lockOrder } from "@/lib/orderLock";
import { secureApi } from "@/lib/secureApi";
import { isChargeBlocked, chargeBlockedResponse } from "@/lib/chargeGuard";
import { terminalClaimKey } from "@/lib/payments/methods";
import { releaseOrderFromPaying } from "@/lib/payments/orderStatusAfterDecline";
import { cancelCloudTerminalPayment, type CloudTerminalAbortResult } from "@/lib/payments/kushki/cloudTerminal";
import { kushkiTerminalSetup, usableTerminalDevices } from "@/lib/payments/terminalAvailability";
import { checkTerminalChargeOnce } from "@/lib/payments/terminalRecovery";
import {
  TERMINAL_CANCELED_REASON,
  canHandleTerminalAttempt,
  terminalAttemptState,
  toTerminalAttemptView,
} from "@/lib/payments/terminalAttempt";

/**
 * Destrabar un cobro del datáfono Kushki YA enviado al equipo (reclamo
 * `terminal:<id>`) que no se aprobó. Nació con Son y Melona (2026-11-04): la
 * persona canceló en el datáfono y la cuenta quedó bloqueada.
 *
 *   - `{ action: "cancel" }` → «Cancelar y cobrar de otra forma».
 *   - `{ action: "retry" }`  → «Reintentar en el datáfono»: cierra el intento
 *     como no cobrado y deja un pago NUEVO por el mismo monto, como lo deja
 *     `terminal-request`. La pantalla lo empuja enseguida por
 *     `terminal/charge` (mismo camino que el botón de siempre: el reclamo
 *     bajo `lockOrder`, el chequeo de "sigue pendiente", el control de caja).
 *     La respuesta trae `deviceId`: el mismo equipo del intento anterior.
 *
 * Qué se puede hacer depende de lo que se sabe del intento
 * (`terminalAttemptState`, re-leído bajo `lockOrder`):
 *
 *   - `answered` (el equipo contestó que no aprobó, el cobro síncrono ya
 *     terminó): las dos acciones, al instante, para cualquiera que pueda
 *     cobrar la mesa (mesero incluido), con `confirmed: true` (confirmó en la
 *     pantalla del datáfono que el cobro no salió). Deja auditoría.
 *   - `in_flight` (el cobro síncrono todavía espera la tarjeta): `cancel`
 *     SOLO le pide al equipo que cancele (`/sync/abort`) y no toca el pago;
 *     el cobro en vuelo vuelve con la respuesta de la cancelación y ESA
 *     libera la cuenta. Nunca se declina acá: la respuesta todavía puede ser
 *     aprobado. `retry` → 409 terminal_result_pending.
 *   - `no_answer` (timeout, red, 5xx: el equipo PUDO cobrar): 409
 *     terminal_no_answer. Eso sigue en "Resolver cobro" (resolve-terminal):
 *     administrador y evidencia, sin espera obligatoria.
 *
 * `{ action: "check" }` → «Consultar en Kushki» (sin respuesta o con
 * respuesta no definitiva): busca el resultado real en Kushki y, si es
 * definitivo, lo registra (ver `checkWithKushki`).
 *
 * Carreras: todo cambio ocurre bajo `lockOrder`, como `terminal/charge`,
 * `cancel-request` y el cobro del staff. Dos personas reintentando a la vez
 * → la segunda ve el pago ya declinado (409 already_settled). Reintento
 * contra efectivo: si el efectivo llega primero choca con el intento en
 * vuelo (409); si el reintento llega primero, el pago nuevo es sólo una
 * solicitud y el efectivo la reemplaza, y entonces `terminal/charge` lo
 * encuentra declinado y no llama a Kushki. Nunca se cobra dos veces.
 */

const schema = z.object({
  action: z.enum(["cancel", "retry", "check"]),
  confirmed: z.literal(true).optional(),
});

/** Entre dos consultas a Kushki del mismo cobro (varias pantallas abiertas). */
const CHECK_MIN_INTERVAL_MS = 10_000;

/** Mandar el cobro al datáfono es lo que hace `terminal/charge`: mismos roles. */
const RETRY_ROLES = new Set(["operator", "platform_admin", "terminal", "mesero"]);

type Refusal = { error: string; status: number };
type Closed = {
  kind: "closed";
  orderId: string;
  orderStatus: string | null;
  nextPaymentId: string | null;
  deviceId: string | null;
};
type Abort = { kind: "abort"; orderId: string; deviceId: string | null };

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const actor = session.user;
  if (!canHandleTerminalAttempt(actor.role)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  const { action, confirmed } = parsed.data;
  if (action === "retry" && !RETRY_ROLES.has(actor.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const payment = await db.payment.findUnique({ where: { id }, include: { order: true } });
  if (!payment) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const restaurantId = payment.order.restaurantId;
  if (restaurantId !== (await getActiveRestaurantId())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (payment.method !== "kushki_card_terminal") return NextResponse.json({ error: "wrong_method" }, { status: 400 });
  if (payment.status !== "pending") return NextResponse.json({ error: "already_settled" }, { status: 409 });
  // «Consultar en Kushki»: sólo LEE el resultado real del cobro y, si es
  // definitivo, lo registra. No es una decisión de caja: no lo frena "solo
  // el administrador cobra".
  if (action === "check") return checkWithKushki(payment, actor);
  // Control de caja: cerrar o reintentar un cobro es cobrar.
  if (await isChargeBlocked(actor.role, restaurantId)) return chargeBlockedResponse();

  const outcome = await db.$transaction(async (tx): Promise<Refusal | Closed | Abort> => {
    await lockOrder(tx, payment.orderId);
    const current = await tx.payment.findUniqueOrThrow({ where: { id }, include: { order: true } });
    if (current.status !== "pending") return { error: "already_settled", status: 409 };
    const claim = await tx.financialOperation.findUnique({ where: { key: terminalClaimKey(id) } });
    // Sin reclamo nunca salió hacia el equipo: es una solicitud y se cancela
    // con cancel-request.
    if (!claim) return { error: "terminal_not_sent", status: 409 };
    const view = toTerminalAttemptView(claim, current.reconciliationRequired)!;
    const state = terminalAttemptState(view, Date.now());
    if (state === "no_answer") return { error: "terminal_no_answer", status: 409 };

    const audit = (kind: string, extra: Record<string, unknown>) =>
      tx.auditEvent.create({
        data: {
          restaurantId,
          actorUserId: actor.id,
          actorEmail: actor.email ?? "",
          actorRole: actor.role,
          kind,
          targetType: "payment",
          targetId: current.id,
          summary: `${kind} ${claim.answerCode ?? ""}`.trim(),
          diff: {
            method: current.method,
            amountCents: current.amountCents,
            tipCents: current.tipCents,
            pushedAt: view.pushedAt,
            answeredAt: view.answeredAt,
            answerCode: view.answerCode,
            answerMessage: view.answerMessage,
            deviceId: claim.deviceId ?? null,
            ...extra,
          },
        },
      });

    if (state === "in_flight") {
      if (action === "retry") return { error: "terminal_result_pending", status: 409 };
      await audit("payment.terminal_abort_requested", {});
      return { kind: "abort", orderId: current.orderId, deviceId: claim.deviceId ?? null };
    }

    // answered: el equipo contestó que no aprobó y el cobro síncrono terminó.
    if (confirmed !== true) return { error: "confirmation_required", status: 400 };
    await tx.payment.update({ where: { id }, data: { status: "declined", reconciliationRequired: false } });
    const next =
      action === "retry"
        ? await tx.payment.create({
            data: {
              orderId: current.orderId,
              method: "kushki_card_terminal",
              status: "pending",
              amountCents: current.amountCents,
              tipCents: current.tipCents,
              splitOfCount: current.splitOfCount,
              collectedByUserId: current.collectedByUserId,
            },
          })
        : null;
    await tx.financialOperation.updateMany({
      where: { key: claim.key },
      data: {
        ...(claim.status === "pending" || claim.status === "uncertain" ? { status: "failed" } : {}),
        ...(next ? { nextPaymentId: next.id } : {}),
      },
    });
    const orderStatus = await releaseOrderFromPaying(tx, current.orderId, current.order.status);
    await audit(action === "retry" ? "payment.terminal_retried" : "payment.terminal_attempt_cancelled", {
      before: { status: current.status, orderStatus: current.order.status },
      after: { status: "declined", orderStatus: orderStatus ?? current.order.status },
      nextPaymentId: next?.id ?? null,
      confirmedOnDevice: true,
    });
    return {
      kind: "closed",
      orderId: current.orderId,
      orderStatus,
      nextPaymentId: next?.id ?? null,
      deviceId: claim.deviceId ?? null,
    };
  });

  if ("error" in outcome) return NextResponse.json({ error: outcome.error }, { status: outcome.status });

  if (outcome.kind === "abort") {
    const abort = await abortOnDevice(restaurantId, outcome.deviceId, id);
    // No cambió nada en la cuenta: lo que llegue del equipo la actualiza.
    return NextResponse.json({ ok: true, status: "abort_requested", abort: abort.status }, { status: 202 });
  }

  publishOrderEvent(restaurantId, { type: "order.updated", orderId: outcome.orderId });
  publishOrderEvent(restaurantId, {
    type: "payment.declined",
    orderId: outcome.orderId,
    paymentId: id,
    reason: TERMINAL_CANCELED_REASON,
  });
  if (!outcome.nextPaymentId) {
    return NextResponse.json({ ok: true, status: "declined", orderStatus: outcome.orderStatus });
  }
  return NextResponse.json({
    ok: true,
    status: "retry",
    paymentId: outcome.nextPaymentId,
    deviceId: outcome.deviceId ?? (await onlyUsableDevice(restaurantId)),
  });
}

/**
 * Le pide al equipo que cancele el cobro en curso. Con el mock no hay equipo
 * real: el cobro simulado termina solo.
 */
async function abortOnDevice(
  restaurantId: string,
  deviceId: string | null,
  paymentId: string,
): Promise<CloudTerminalAbortResult | { status: "mock" }> {
  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant) return { status: "error" };
  const { mode, businessCode, useRealTerminal } = await kushkiTerminalSetup(tenant);
  if (!useRealTerminal) return { status: "mock" };
  const device = deviceId ? await db.terminalDevice.findUnique({ where: { kushkiDeviceId: deviceId } }) : null;
  if (!device?.serialNumber || device.restaurantId !== restaurantId) return { status: "error" };
  return cancelCloudTerminalPayment(device.serialNumber, paymentId, businessCode, mode);
}

/**
 * «Consultar en Kushki»: el cobro se envió y no hubo respuesta. Busca el
 * resultado real (`transaction_search_online` por el `client_transaction_id`
 * del reclamo) y, si es definitivo, lo registra por el mismo camino que la
 * respuesta del datáfono (aprobado → cuenta saldada, factura e impresión;
 * rechazado → cuenta libre). Sin resultado, no cambia nada: sigue siendo
 * "Resolver cobro". Mientras el cobro está en curso no se ofrece: la
 * recuperación de `terminal/charge` ya está consultando.
 */
async function checkWithKushki(
  payment: { id: string; amountCents: number; reconciliationRequired: boolean; order: { restaurantId: string; id: string } },
  actor: { id: string; email?: string | null; role: string },
) {
  const restaurantId = payment.order.restaurantId;
  const claim = await db.financialOperation.findUnique({ where: { key: terminalClaimKey(payment.id) } });
  if (!claim) return NextResponse.json({ error: "terminal_not_sent" }, { status: 409 });
  const state = terminalAttemptState(toTerminalAttemptView(claim, payment.reconciliationRequired)!, Date.now());
  if (state === "in_flight") return NextResponse.json({ error: "terminal_result_pending" }, { status: 409 });
  if (!claim.clientTransactionId) return NextResponse.json({ error: "terminal_check_unavailable" }, { status: 409 });
  if (claim.checkedAt && Date.now() - claim.checkedAt.getTime() < CHECK_MIN_INTERVAL_MS) {
    return NextResponse.json({ ok: true, status: "checked", result: claim.checkStatus ?? "error", cached: true });
  }
  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { mode, businessCode, useRealTerminal } = await kushkiTerminalSetup(tenant);
  const device = claim.deviceId ? await db.terminalDevice.findUnique({ where: { kushkiDeviceId: claim.deviceId } }) : null;
  if (!useRealTerminal || !device?.serialNumber || device.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "terminal_check_unavailable" }, { status: 409 });
  }
  const check = await checkTerminalChargeOnce({
    restaurantId,
    paymentId: payment.id,
    amountCents: payment.amountCents,
    serialNumber: device.serialNumber,
    clientTransactionId: claim.clientTransactionId,
    businessCode,
    mode,
  });
  if (check.settled) {
    try {
      await db.auditEvent.create({
        data: {
          restaurantId,
          actorUserId: actor.id,
          actorEmail: actor.email ?? "",
          actorRole: actor.role,
          kind: "payment.terminal_recovered",
          targetType: "payment",
          targetId: payment.id,
          summary: `payment.terminal_recovered ${check.settled}`,
          diff: { outcome: check.settled, providerRef: check.providerRef ?? null, source: "transaction_search_online" },
        },
      });
    } catch (err) {
      console.warn("[terminal-attempt] no se pudo auditar la consulta", err);
    }
    return NextResponse.json({ ok: true, status: check.settled });
  }
  return NextResponse.json({ ok: true, status: "checked", result: check.settleFailed ? "error" : check.search });
}

/** Reclamos viejos sin `deviceId`: si el comercio tiene un solo datáfono, es ése. */
async function onlyUsableDevice(restaurantId: string): Promise<string | null> {
  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant) return null;
  const { devices } = await usableTerminalDevices(tenant);
  return devices.length === 1 ? devices[0].id : null;
}

export const POST = secureApi(POSTHandler);
