import "server-only";
import { createHash } from "node:crypto";
import type { BreBCharge, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { publishOrderEvent } from "@/lib/events";
import { lockOrder } from "@/lib/orderLock";
import { settlePaymentLinkInTx } from "@/lib/paymentLinks";
import { getRestaurantKushkiMode, type KushkiMode } from "@/lib/platformConfig";
import {
  BRE_B_QR_TTL_SECONDS,
  isBreBQrImage,
  type BreBStatusResult,
  type BreBWebhookEvent,
} from "../kushki/breB";
import { prepareStaffCharge } from "../staffCharge";
import { processKushkiWebhook } from "../webhookHandler";
import { readBreBCredentials, type BreBCredentialFields } from "./credentials";
import {
  breBFailureKind,
  breBFailureLabel,
  breBGatewayFor,
  breBStartError,
  isBreBAlreadyFinal,
  type BreBGateway,
} from "./gateway";
import {
  BRE_B_CREATING_STALE_MS,
  BRE_B_EXPIRY_GRACE_MS,
  BRE_B_STATUS_THROTTLE_MS,
  breBExpired,
  verifyBreBApproval,
  type BreBReviewCode,
} from "./rules";
import {
  BRE_B_OPEN_STATES,
  asBreBState,
  isBreBOpenState,
  type BreBChargeView,
  type BreBPendingView,
} from "./view";

/**
 * Cobro por Bre-B (QR de pago inmediato vía Kushki). Orquesta el intento
 * (`BreBCharge`) alrededor del `Payment` de la cuenta o de un `PaymentLink`
 * de monto fijo. El contrato con Kushki NO vive acá (ver
 * `../kushki/breB.ts`); acá viven las reglas de plata:
 *
 *   · El pago se RESERVA antes de hablar con Kushki (pendiente, en vuelo):
 *     mientras exista, nadie cobra esa parte por otro medio.
 *   · FALLA CERRADO. Sin respuesta (red, timeout, 5xx), o con una respuesta
 *     que no se entiende, el pago queda pendiente y marcado para
 *     conciliación (`uncertain`). Nunca se asume aprobado, y sólo se libera
 *     cuando se SABE que nadie puede pagar ese QR.
 *   · Un rechazo DEFINITIVO sí libera la cuenta de una: un 4xx de Kushki al
 *     pedir el QR (401, E046, E049…), un `declinedTransaction`, o la
 *     cancelación confirmada (204). Un 400 T023 al cancelar no es un fallo:
 *     dice que ya hay un resultado final, y se aplica ese.
 *   · Una aprobación se salda sólo si la referencia, el monto y la moneda
 *     son los del cobro. Si no, va a conciliación.
 *   · Saldar pasa por `processKushkiWebhook` —el mismo motor del resto de
 *     medios: totales, rondas prepagas, factura, impresión automática— con
 *     un `eventId` estable por cobro, así el aviso y la consulta de estado
 *     cuentan una sola vez.
 *   · Una aprobación que llega sobre un intento ya cancelado o vencido no se
 *     pierde: el pago queda aprobado y marcado para conciliación.
 */

export type BreBTenant = BreBCredentialFields & {
  id: string;
  name: string;
  country: string | null;
  kushkiMode: string | null;
};

export const BRE_B_TENANT_SELECT = {
  id: true,
  name: true,
  country: true,
  kushkiMode: true,
  kushkiBreBPublicKey: true,
  kushkiBreBPrivateKeyEnc: true,
} as const;

export type BreBStartResult =
  | { ok: true; httpStatus: 200 | 202; view: BreBChargeView }
  | { ok: false; httpStatus: number; error: string; paymentId?: string };

const OPEN = [...BRE_B_OPEN_STATES] as string[];

/** Códigos con los que un cobro quedó para revisión humana: no se cierra solo. */
const REVIEW_CODES: readonly string[] = [
  "reference_mismatch",
  "amount_unverified",
  "amount_mismatch",
  "currency_mismatch",
  "settle_failed",
] satisfies readonly (BreBReviewCode | "settle_failed")[];

const reviewLocked = (charge: Pick<BreBCharge, "status" | "failureCode">) =>
  charge.status === "uncertain" && !!charge.failureCode && REVIEW_CODES.includes(charge.failureCode);

const fail = (httpStatus: number, error: string, paymentId?: string): BreBStartResult => ({
  ok: false,
  httpStatus,
  error,
  ...(paymentId ? { paymentId } : {}),
});

// ── Vistas ────────────────────────────────────────────────────────────────

export async function breBChargeView(
  charge: BreBCharge,
  opts: { withQr?: boolean } = {},
): Promise<BreBChargeView> {
  const state = asBreBState(charge.status);
  let orderPaid = false;
  if (charge.paymentId && state === "approved") {
    const payment = await db.payment.findUnique({
      where: { id: charge.paymentId },
      select: { order: { select: { status: true } } },
    });
    orderPaid = payment?.order.status === "paid";
  }
  const view: BreBChargeView = {
    chargeId: charge.id,
    paymentId: charge.paymentId,
    state,
    amountCents: charge.amountCents,
    currency: charge.currency,
    expiresAt: charge.expiresAt?.toISOString() ?? null,
    serverNow: new Date().toISOString(),
    orderPaid,
    reason: charge.failureCode,
    mockUrl:
      charge.mode === "mock" && process.env.NODE_ENV !== "production" && state === "active"
        ? `/t/bre-b-mock?c=${encodeURIComponent(charge.id)}`
        : null,
  };
  if (opts.withQr && state === "active") {
    // Sólo sale hacia la pantalla un PNG incrustado, validado otra vez acá.
    view.qrImage = isBreBQrImage(charge.qrImage) ? charge.qrImage : null;
  }
  return view;
}

/**
 * Estado de los Bre-B pendientes de una cuenta, para los avisos del staff
 * (ficha de la mesa, cobro, Salón): `paymentId → { state, expiresAt }`.
 * Sólo consulta si hay algún pago Bre-B.
 */
export async function breBPendingViews(
  client: Pick<Prisma.TransactionClient, "breBCharge">,
  payments: ReadonlyArray<{ id: string; method: string }>,
): Promise<Map<string, BreBPendingView>> {
  const ids = payments.filter((p) => p.method === "kushki_bre_b").map((p) => p.id);
  if (ids.length === 0) return new Map();
  const charges = await client.breBCharge.findMany({
    where: { paymentId: { in: ids } },
    select: { paymentId: true, status: true, expiresAt: true },
  });
  return new Map(
    charges
      .filter((c): c is typeof c & { paymentId: string } => !!c.paymentId)
      .map((c) => [c.paymentId, { state: asBreBState(c.status), expiresAt: c.expiresAt?.toISOString() ?? null }]),
  );
}

// ── Crear el cobro ────────────────────────────────────────────────────────

async function resolveStart(tenant: BreBTenant, currency: string): Promise<
  { ok: true; mode: KushkiMode; gateway: BreBGateway } | { ok: false; result: BreBStartResult }
> {
  const mode = await getRestaurantKushkiMode(tenant);
  if (mode === "mock" && process.env.NODE_ENV === "production") {
    return { ok: false, result: fail(409, "mock_payments_disabled") };
  }
  // Bre-B es un riel exclusivo de Colombia, en pesos.
  if (currency !== "COP") return { ok: false, result: fail(409, "bre_b_not_available") };
  const creds = readBreBCredentials(tenant);
  if (!creds) return { ok: false, result: fail(503, "bre_b_not_configured") };
  return { ok: true, mode, gateway: breBGatewayFor(mode, creds) };
}

/**
 * Cobro Bre-B de (una parte de) una cuenta. Reserva el pago y pide el QR.
 * `staffCharge`: quien cobra es del equipo → reemplaza las solicitudes del
 * comensal (efectivo, datáfono sin enviar) y, si otro pago en vuelo es lo
 * único que estorba, lanza `PendingPaymentInFlightError` (409 accionable).
 */
export async function startOrderBreBCharge(input: {
  tenant: BreBTenant;
  orderId: string;
  amountCents: number;
  tipCents: number;
  collectedByUserId: string | null;
  staffCharge: boolean;
  idempotencyKey?: string | null;
  /** URL pública (https) de `/api/webhooks/kushki`, para avisar de este cobro. */
  webhookUrl?: string | null;
}): Promise<BreBStartResult> {
  const currency = await getCurrencyForCountry(input.tenant.country);
  const start = await resolveStart(input.tenant, currency);
  if (!start.ok) return start.result;

  const requestKey = input.idempotencyKey
    ? createHash("sha256").update(`${input.orderId}:kushki_bre_b:${input.idempotencyKey}`).digest("hex")
    : undefined;
  const reserved = await db.$transaction(async (tx) => {
    await lockOrder(tx, input.orderId);
    if (requestKey) {
      const existing = await tx.payment.findUnique({ where: { requestKey } });
      if (existing) {
        if (existing.amountCents !== input.amountCents || existing.tipCents !== input.tipCents) {
          throw new Error("operation_conflict");
        }
        const charge = await tx.breBCharge.findUnique({ where: { paymentId: existing.id } });
        return { paymentId: existing.id, charge, created: false };
      }
    }
    const order = await tx.order.findUniqueOrThrow({ where: { id: input.orderId } });
    if (order.status === "paid" || order.status === "cancelled") throw new Error("order_closed");
    if (input.staffCharge) await prepareStaffCharge(tx, input.orderId, input.amountCents - input.tipCents);
    // El trigger `mesapay_reserve_payment` reserva el saldo acá: si otro pago
    // ya lo tiene tomado, este INSERT rebota y no se pide ningún QR.
    const payment = await tx.payment.create({
      data: {
        orderId: input.orderId,
        method: "kushki_bre_b",
        status: "pending",
        amountCents: input.amountCents,
        tipCents: input.tipCents,
        collectedByUserId: input.collectedByUserId,
        requestKey,
      },
    });
    const charge = await tx.breBCharge.create({
      data: {
        restaurantId: input.tenant.id,
        paymentId: payment.id,
        mode: start.mode,
        amountCents: input.amountCents,
        currency,
        status: "creating",
      },
    });
    return { paymentId: payment.id, charge, created: true };
  });

  if (!reserved.created) {
    // Reintento con la misma llave: se devuelve el mismo cobro, sin otro QR.
    if (!reserved.charge) return fail(409, "operation_conflict", reserved.paymentId);
    return { ok: true, httpStatus: 200, view: await breBChargeView(reserved.charge, { withQr: true }) };
  }
  publishOrderEvent(input.tenant.id, { type: "order.updated", orderId: input.orderId });
  return issueQr(reserved.charge!, start.gateway, {
    description: `${input.tenant.name} · ${input.orderId.slice(0, 6)}`,
    metadata: { chargeId: reserved.charge!.id, paymentId: reserved.paymentId, orderId: input.orderId },
    webhookUrl: input.webhookUrl,
  });
}

/**
 * Cobro Bre-B de un link de pago de monto fijo (no hay `Payment`). Un solo
 * QR vivo por link: si ya hay uno vigente, se retoma en vez de crear otro
 * (dos QR pagables del mismo link serían dos cobros).
 */
export async function startLinkBreBCharge(input: {
  tenant: BreBTenant;
  link: { id: string; amountCents: number; currency: string };
  webhookUrl?: string | null;
}): Promise<BreBStartResult> {
  const start = await resolveStart(input.tenant, input.link.currency);
  if (!start.ok) return start.result;

  for (let attempt = 0; attempt < 2; attempt++) {
    const reserved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PaymentLink" WHERE id = ${input.link.id} FOR UPDATE`;
      const open = await tx.breBCharge.findFirst({
        where: { paymentLinkId: input.link.id, status: { in: OPEN } },
        orderBy: { createdAt: "desc" },
      });
      if (open) return { charge: open, created: false };
      const charge = await tx.breBCharge.create({
        data: {
          restaurantId: input.tenant.id,
          paymentLinkId: input.link.id,
          mode: start.mode,
          amountCents: input.link.amountCents,
          currency: input.link.currency,
          status: "creating",
        },
      });
      return { charge, created: true };
    });
    if (reserved.created) {
      return issueQr(reserved.charge, start.gateway, {
        description: `${input.tenant.name} · link ${input.link.id.slice(0, 6)}`,
        metadata: { chargeId: reserved.charge.id, paymentLinkId: input.link.id },
        webhookUrl: input.webhookUrl,
      });
    }
    // Había uno abierto: si sigue vigente se muestra; si ya venció, se cierra
    // y se intenta de nuevo con uno nuevo.
    const fresh = await checkBreBCharge(reserved.charge.id);
    if (fresh && isBreBOpenState(fresh.status)) {
      return {
        ok: true,
        httpStatus: fresh.status === "uncertain" ? 202 : 200,
        view: await breBChargeView(fresh, { withQr: true }),
      };
    }
  }
  return fail(409, "operation_conflict");
}

/**
 * Lo que Kushki dice al intentar cancelar:
 *   canceled    — 204: el QR quedó inválido.
 *   final       — ya había un resultado final (400 T023, o lo dice el
 *                 status): se aplica ESE resultado, no es un fallo.
 *   unconfirmed — sin respuesta: no se sabe si el QR sigue vivo.
 */
type CancelOutcome =
  | { kind: "canceled" }
  | { kind: "final"; result: BreBStatusResult }
  | { kind: "unconfirmed" };

async function cancelAtProvider(chargeId: string, token: string, gateway: BreBGateway): Promise<CancelOutcome> {
  try {
    await gateway.cancel(token);
    return { kind: "canceled" };
  } catch (err) {
    console.warn("[bre-b] cancel not confirmed", {
      chargeId,
      failure: breBFailureLabel(err),
      alreadyFinal: isBreBAlreadyFinal(err),
    });
    // T023 = ya llegó a un estado final. Y ante cualquier otro fallo también
    // vale preguntar: pudo pagarse justo antes.
    try {
      const result = await gateway.status(token);
      if (result.status !== "pending") return { kind: "final", result };
    } catch (statusErr) {
      console.warn("[bre-b] status after failed cancel", { chargeId, failure: breBFailureLabel(statusErr) });
    }
    return { kind: "unconfirmed" };
  }
}

async function issueQr(
  charge: BreBCharge,
  gateway: BreBGateway,
  input: {
    description: string;
    metadata: { chargeId: string; paymentId?: string; orderId?: string; paymentLinkId?: string };
    webhookUrl?: string | null;
  },
): Promise<BreBStartResult> {
  const paymentId = charge.paymentId ?? undefined;

  // 1) Config: el procesador Bre-B del comercio (nombre y canal van tal cual
  //    al token). Sin procesador, Kushki todavía no le habilitó Bre-B.
  let processor;
  try {
    processor = await gateway.processor();
  } catch (err) {
    console.error("[bre-b] config failed", { chargeId: charge.id, failure: breBFailureLabel(err) });
    await closeCharge(charge.id, "declined", `config_${breBFailureKind(err)}`);
    return fail(502, breBStartError(err), paymentId);
  }
  if (!processor) {
    await closeCharge(charge.id, "declined", "processor_unavailable");
    return fail(409, "bre_b_processor_unavailable", paymentId);
  }

  // 2) Token (un solo uso, 30 minutos).
  let token: string;
  try {
    ({ token } = await gateway.requestToken({
      amountCents: charge.amountCents,
      currency: "COP",
      processor,
      description: input.description,
    }));
  } catch (err) {
    // Sin token no hay init, y sin init no existe ningún QR: nadie puede
    // pagar. Es seguro liberar la cuenta, sea cual sea el fallo.
    console.error("[bre-b] token failed", { chargeId: charge.id, failure: breBFailureLabel(err) });
    if (breBFailureKind(err) === "rejected") gateway.forgetProcessor();
    await closeCharge(charge.id, "declined", `token_${breBFailureKind(err)}`);
    return fail(502, breBStartError(err), paymentId);
  }
  // El token se guarda ANTES del init: si la respuesta del init se pierde,
  // con él se consulta y se cancela.
  await db.breBCharge.update({ where: { id: charge.id }, data: { token, processorName: processor.name } });

  // 3) Init: devuelve el QR, que vence a los 10 minutos. El vencimiento se
  //    cuenta desde ANTES de pedirlo: nunca se muestra un QR que Kushki ya
  //    dio por vencido.
  const requestedAt = Date.now();
  let init;
  try {
    init = await gateway.init({
      token,
      amountCents: charge.amountCents,
      metadata: input.metadata,
      webhookUrl: input.webhookUrl,
    });
  } catch (err) {
    const kind = breBFailureKind(err);
    console.error("[bre-b] init failed", { chargeId: charge.id, failure: breBFailureLabel(err) });
    if (kind === "rejected") {
      // Rechazo definitivo (401, 422 E046, 404 E049, 400…): no se creó nada.
      gateway.forgetProcessor();
      await closeCharge(charge.id, "declined", "init_rejected");
      return fail(502, breBStartError(err), paymentId);
    }
    // Sin respuesta, o una que no se entiende: Kushki pudo haber emitido un
    // QR que nadie vio. Se intenta invalidarlo; sólo si Kushki lo confirma
    // (o dice que ya está rechazado) se libera la cuenta. Si no, queda
    // pendiente para conciliación.
    const cancel = await cancelAtProvider(charge.id, token, gateway);
    if (cancel.kind === "canceled" || (cancel.kind === "final" && cancel.result.status === "declined")) {
      await closeCharge(charge.id, "declined", `init_${kind}`);
      return fail(502, "bre_b_unavailable", paymentId);
    }
    if (cancel.kind === "final") {
      await applyApproval(charge, cancel.result, "status", { source: "status", status: cancel.result.status });
    } else {
      await markUncertain(charge.id, `init_${kind}`);
    }
    const current = await db.breBCharge.findUniqueOrThrow({ where: { id: charge.id } });
    return { ok: true, httpStatus: 202, view: await breBChargeView(current) };
  }

  const activated = await db.breBCharge.updateMany({
    where: { id: charge.id, status: "creating" },
    data: {
      status: "active",
      qrImage: init.qrImage,
      expiresAt: new Date(requestedAt + BRE_B_QR_TTL_SECONDS * 1000),
      transactionReference: init.transactionReference,
      ticketNumber: init.ticketNumber,
    },
  });
  if (activated.count === 0) {
    // Lo cancelaron mientras se pedía el QR: el que acaba de nacer se invalida.
    await cancelAtProvider(charge.id, token, gateway);
  }
  const current = await db.breBCharge.findUniqueOrThrow({ where: { id: charge.id } });
  return { ok: true, httpStatus: 200, view: await breBChargeView(current, { withQr: true }) };
}

// ── Transiciones ──────────────────────────────────────────────────────────

async function notifyOrder(charge: Pick<BreBCharge, "paymentId" | "restaurantId">): Promise<void> {
  if (!charge.paymentId) return;
  const payment = await db.payment.findUnique({ where: { id: charge.paymentId }, select: { orderId: true } });
  if (payment) publishOrderEvent(charge.restaurantId, { type: "order.updated", orderId: payment.orderId });
}

/**
 * Cierra el cobro SIN pago: Kushki lo rechazó, venció, o se canceló y Kushki
 * lo confirmó. Declina el pago por el motor común (la cuenta sale de
 * `paying` y queda libre). Si mientras tanto se aprobó, no toca nada.
 */
async function closeCharge(
  chargeId: string,
  status: "declined" | "expired" | "canceled",
  failureCode: string | null,
): Promise<void> {
  const charge = await db.breBCharge.findUnique({ where: { id: chargeId } });
  if (!charge || !isBreBOpenState(charge.status)) return;
  if (charge.paymentId) {
    const result = await processKushkiWebhook({
      eventId: `breb:${charge.id}:closed`,
      type: "bre_b.declined",
      restaurantId: charge.restaurantId,
      paymentId: charge.paymentId,
      message: failureCode ?? status,
      raw: { source: "bre_b", status, failureCode },
    });
    if (result.status === "error") throw new Error("bre_b_close_failed");
    const payment = await db.payment.findUnique({ where: { id: charge.paymentId }, select: { status: true } });
    // Se aprobó en el medio: gana la aprobación.
    if (payment?.status === "approved") return;
  }
  await db.breBCharge.updateMany({
    where: { id: charge.id, status: { in: OPEN } },
    data: {
      status,
      failureCode,
      settledAt: new Date(),
      ...(status === "canceled" ? { canceledAt: new Date() } : {}),
    },
  });
}

/** No se sabe qué pasó: el pago sigue pendiente y marcado para conciliación. */
async function markUncertain(chargeId: string, code: string): Promise<void> {
  const charge = await db.breBCharge.findUnique({ where: { id: chargeId } });
  if (!charge || !isBreBOpenState(charge.status)) return;
  await db.$transaction([
    db.breBCharge.updateMany({
      where: { id: charge.id, status: { in: OPEN } },
      data: { status: "uncertain", failureCode: code },
    }),
    ...(charge.paymentId
      ? [
          db.payment.updateMany({
            where: { id: charge.paymentId, status: "pending" },
            data: { reconciliationRequired: true },
          }),
        ]
      : []),
  ]);
  await notifyOrder(charge);
}

/**
 * Kushki dice "aprobado" pero algo no es lo del cobro (otro monto, otra
 * referencia, sin monto verificable). NO se salda: queda para que un
 * administrador lo resuelva en Cobros, con rastro en la auditoría.
 */
async function flagForReview(
  charge: BreBCharge,
  code: BreBReviewCode,
  received: { amountCents: number | null; currency: string | null },
  source: string,
): Promise<void> {
  const eventId = `breb:${charge.id}:review:${code}:${received.amountCents ?? "na"}`;
  const created = await db.kushkiWebhookEvent.createMany({
    data: [
      {
        eventId,
        type: "bre_b.review",
        restaurantId: charge.restaurantId,
        payload: {
          chargeId: charge.id,
          paymentId: charge.paymentId,
          paymentLinkId: charge.paymentLinkId,
          code,
          source,
          expectedAmountCents: charge.amountCents,
          expectedCurrency: charge.currency,
          receivedAmountCents: received.amountCents,
          receivedCurrency: received.currency,
        },
        processedAt: new Date(),
        error: `bre_b_${code}`,
      },
    ],
    skipDuplicates: true,
  });
  await db.breBCharge.update({
    where: { id: charge.id },
    data: {
      ...(isBreBOpenState(charge.status) ? { status: "uncertain" } : {}),
      failureCode: code,
      checkStatus: code,
      checkedAt: new Date(),
    },
  });
  if (charge.paymentId) {
    await db.payment.updateMany({
      where: { id: charge.paymentId, status: { in: ["pending", "declined"] } },
      data: { reconciliationRequired: true },
    });
  }
  if (created.count > 0) {
    await db.auditEvent.create({
      data: {
        restaurantId: charge.restaurantId,
        actorEmail: "kushki",
        actorRole: "system",
        kind: "payment.bre_b_review",
        targetType: charge.paymentId ? "payment" : "payment_link",
        targetId: charge.paymentId ?? charge.paymentLinkId,
        summary: `Bre-B informó una aprobación que no coincide con el cobro (${code}); requiere revisión.`,
        diff: {
          chargeId: charge.id,
          code,
          source,
          expectedAmountCents: charge.amountCents,
          receivedAmountCents: received.amountCents,
          expectedCurrency: charge.currency,
          receivedCurrency: received.currency,
        },
      },
    });
  }
  await notifyOrder(charge);
}

/**
 * Aplica una aprobación ya leída de Kushki (aviso o consulta de estado).
 * Verifica referencia, monto y moneda ANTES de saldar.
 */
async function applyApproval(
  charge: BreBCharge,
  outcome: Pick<BreBStatusResult, "amountCents" | "currency" | "token" | "transactionReference" | "ticketNumber">,
  source: "webhook" | "status" | "mock",
  raw: unknown,
): Promise<void> {
  if (charge.status === "approved") return;
  const check = verifyBreBApproval(
    {
      amountCents: charge.amountCents,
      currency: charge.currency,
      token: charge.token,
      transactionReference: charge.transactionReference,
      ticketNumber: charge.ticketNumber,
    },
    outcome,
  );
  if (!check.ok) {
    await flagForReview(charge, check.code, { amountCents: outcome.amountCents, currency: outcome.currency }, source);
    return;
  }
  const providerRef =
    outcome.transactionReference ??
    charge.transactionReference ??
    outcome.ticketNumber ??
    charge.ticketNumber ??
    charge.token ??
    `breb:${charge.id}`;
  const references = {
    transactionReference: outcome.transactionReference ?? charge.transactionReference,
    ticketNumber: outcome.ticketNumber ?? charge.ticketNumber,
  };

  if (charge.paymentId) {
    const before = await db.payment.findUnique({ where: { id: charge.paymentId }, select: { status: true } });
    const result = await processKushkiWebhook({
      eventId: `breb:${charge.id}:approved`,
      type: "bre_b.approved",
      restaurantId: charge.restaurantId,
      paymentId: charge.paymentId,
      providerRef,
      // Ya verificado contra el cobro: el motor exige que sea el del pago.
      amountCents: charge.amountCents,
      message: source,
      raw,
    });
    if (result.status === "error") {
      // El resultado es definitivo pero no se pudo registrar: no se pierde.
      await markUncertain(charge.id, "settle_failed");
      return;
    }
    // Llegó sobre un intento cancelado / vencido: el motor ya dejó el pago
    // aprobado y marcado para conciliación. Queda además en la auditoría.
    const late = before?.status === "declined";
    await db.breBCharge.update({
      where: { id: charge.id },
      data: {
        status: "approved",
        settledAt: new Date(),
        checkStatus: "approved",
        failureCode: late ? "late_approval" : null,
        ...references,
      },
    });
    if (late && result.status === "ok") {
      await db.auditEvent.create({
        data: {
          restaurantId: charge.restaurantId,
          actorEmail: "kushki",
          actorRole: "system",
          kind: "payment.bre_b_late_approval",
          targetType: "payment",
          targetId: charge.paymentId,
          summary: "Bre-B aprobó un cobro que ya se había cancelado o vencido; requiere conciliación.",
          diff: {
            chargeId: charge.id,
            closedAs: charge.status,
            cancelReason: charge.cancelReason,
            amountCents: charge.amountCents,
            providerRef,
            source,
          },
        },
      });
    }
    return;
  }

  if (charge.paymentLinkId) {
    const linkId = charge.paymentLinkId;
    // Espejo del cobro (sin Payment: no hay cuenta). Best-effort.
    try {
      await db.kushkiTransaction.upsert({
        where: { kushkiTxId: providerRef },
        update: {},
        create: {
          restaurantId: charge.restaurantId,
          kushkiTxId: providerRef,
          kind: "charge",
          status: "approved",
          amountCents: charge.amountCents,
          currency: charge.currency,
          raw: (raw ?? {}) as object,
          message: source,
        },
      });
    } catch (err) {
      console.error("[bre-b] link mirror failed", { chargeId: charge.id, error: err instanceof Error ? err.name : "unknown" });
    }
    const settled = await db.$transaction((tx) =>
      settlePaymentLinkInTx(tx, { id: linkId }, { approved: true, providerRef, method: "kushki_bre_b" }),
    );
    // El link ya estaba cerrado (pagado por otro medio, cancelado): la plata
    // entró igual. Queda aprobado y con rastro para devolverla a mano.
    const duplicate = settled.status !== "paid";
    await db.breBCharge.update({
      where: { id: charge.id },
      data: {
        status: "approved",
        settledAt: new Date(),
        checkStatus: "approved",
        failureCode: duplicate ? "link_already_closed" : null,
        ...references,
      },
    });
    if (duplicate) {
      await db.auditEvent.create({
        data: {
          restaurantId: charge.restaurantId,
          actorEmail: "kushki",
          actorRole: "system",
          kind: "payment_link.bre_b_duplicate",
          targetType: "payment_link",
          targetId: linkId,
          summary: "Bre-B aprobó el pago de un link que ya estaba cerrado; requiere conciliación.",
          diff: { chargeId: charge.id, linkStatus: settled.status, amountCents: charge.amountCents, providerRef, source },
        },
      });
    }
  }
}

async function gatewayOf(charge: BreBCharge): Promise<BreBGateway | null> {
  const mode = charge.mode as KushkiMode;
  if (mode === "mock") return process.env.NODE_ENV === "production" ? null : breBGatewayFor("mock", null);
  const tenant = await db.restaurant.findUnique({
    where: { id: charge.restaurantId },
    select: { kushkiBreBPublicKey: true, kushkiBreBPrivateKeyEnc: true },
  });
  const creds = readBreBCredentials(tenant);
  return creds ? breBGatewayFor(mode, creds) : null;
}

// ── Consultar, vencer, cancelar ───────────────────────────────────────────

/**
 * Trae el estado real de Kushki y lo aplica. Es el respaldo del webhook y
 * lo que recupera el resultado después de un timeout:
 *
 *   aprobado  → se verifica y se salda (o va a revisión si no coincide);
 *   rechazado / vencido / cancelado → se cierra y la cuenta queda libre;
 *   pendiente y ya vencido → se CANCELA en Kushki; sólo si lo confirma se
 *     cierra como vencido. Si no, queda `uncertain`.
 *
 * A Kushki se le pregunta como mucho cada `BRE_B_STATUS_THROTTLE_MS` por
 * cobro (salvo `force`: «Consultar estado» del staff, o el vencimiento).
 */
export async function checkBreBCharge(
  chargeId: string,
  opts: { force?: boolean } = {},
): Promise<BreBCharge | null> {
  const charge = await db.breBCharge.findUnique({ where: { id: chargeId } });
  if (!charge || !isBreBOpenState(charge.status)) return charge;
  const reload = () => db.breBCharge.findUnique({ where: { id: chargeId } });
  const now = new Date();
  const stale = charge.status === "creating" && now.getTime() - charge.createdAt.getTime() > BRE_B_CREATING_STALE_MS;

  if (!charge.token) {
    // El proceso murió antes de pedir el token: nunca existió un QR.
    if (stale) await closeCharge(charge.id, "declined", "never_issued");
    return reload();
  }
  const expired = breBExpired(charge.expiresAt, now) || stale;
  if (
    !opts.force &&
    !expired &&
    charge.checkedAt &&
    now.getTime() - charge.checkedAt.getTime() < BRE_B_STATUS_THROTTLE_MS
  ) {
    return charge;
  }
  // Un solo proceso consulta a la vez: quien no gana el turno espera el suyo.
  const claimed = await db.breBCharge.updateMany({
    where: { id: charge.id, status: { in: OPEN }, checkedAt: charge.checkedAt },
    data: { checkedAt: now },
  });
  if (claimed.count === 0 && !opts.force) return reload();

  const gateway = await gatewayOf(charge);
  let result: BreBStatusResult | null = null;
  let failure: string | null = gateway ? null : "not_configured";
  if (gateway) {
    try {
      result = await gateway.status(charge.token);
    } catch (err) {
      failure = breBFailureKind(err);
      console.warn("[bre-b] status failed", { chargeId: charge.id, failure: breBFailureLabel(err) });
    }
  }
  await db.breBCharge.updateMany({
    where: { id: charge.id },
    data: { checkedAt: new Date(), checkStatus: result?.status ?? `error_${failure}` },
  });

  if (result?.status === "approved") {
    await applyApproval(charge, result, "status", { source: "status", status: result.status });
    return reload();
  }
  // Marcado para revisión humana: sólo una aprobación verificada lo resuelve solo.
  if (reviewLocked(charge)) return reload();
  if (result?.status === "declined") {
    // Kushki no tiene un estado "vencido": un QR que venció sin pago (o que
    // se canceló) queda rechazado. Si ya pasó su hora, se cierra como vencido.
    await closeCharge(charge.id, expired ? "expired" : "declined", "provider_declined");
    return reload();
  }
  if (!expired) return reload();
  if (!gateway) {
    await markUncertain(charge.id, "expire_unconfirmed");
    return reload();
  }
  // Venció y sigue sin pago (o no se pudo consultar): se invalida el QR en
  // Kushki. Sólo con su confirmación se libera la cuenta.
  const cancel = await cancelAtProvider(charge.id, charge.token, gateway);
  if (cancel.kind === "canceled") await closeCharge(charge.id, "expired", null);
  else if (cancel.kind === "final" && cancel.result.status === "approved") {
    await applyApproval(charge, cancel.result, "status", { source: "status", status: cancel.result.status });
  } else if (cancel.kind === "final") await closeCharge(charge.id, "expired", "provider_declined");
  else await markUncertain(charge.id, "expire_unconfirmed");
  return reload();
}

/**
 * Cancela el cobro: el comensal cambió de medio, cerró el QR, o el staff
 * tocó «Cancelar». Kushki invalida el QR; SÓLO si lo confirma se libera la
 * cuenta. Si no lo confirma se consulta el estado (pudo haber pagado justo
 * antes): aprobado → se salda; si sigue sin saberse → `uncertain`.
 */
export async function cancelBreBCharge(
  chargeId: string,
  input: { reason: "payer" | "staff" | "superseded" },
): Promise<BreBCharge | null> {
  const charge = await db.breBCharge.findUnique({ where: { id: chargeId } });
  if (!charge || !isBreBOpenState(charge.status)) return charge;
  // Marcado para revisión: no se cancela a ciegas, se resuelve en Cobros.
  if (reviewLocked(charge)) return charge;
  const reload = () => db.breBCharge.findUnique({ where: { id: chargeId } });
  await db.breBCharge.updateMany({
    where: { id: charge.id, status: { in: OPEN } },
    data: { cancelRequestedAt: new Date(), cancelReason: input.reason },
  });
  if (!charge.token) {
    // Todavía no hay token (el QR se está pidiendo): se cierra; si el QR
    // llega a nacer, `issueQr` lo invalida.
    await closeCharge(charge.id, "canceled", null);
    return reload();
  }
  const gateway = await gatewayOf(charge);
  if (!gateway) {
    await markUncertain(charge.id, "cancel_unconfirmed");
    return reload();
  }
  const cancel = await cancelAtProvider(charge.id, charge.token, gateway);
  if (cancel.kind === "canceled") await closeCharge(charge.id, "canceled", null);
  else if (cancel.kind === "final" && cancel.result.status === "approved") {
    // Pagó justo antes de cancelar: manda el resultado real.
    await applyApproval(charge, cancel.result, "status", { source: "status", status: cancel.result.status });
  } else if (cancel.kind === "final") await closeCharge(charge.id, "declined", "provider_declined");
  else await markUncertain(charge.id, "cancel_unconfirmed");
  return reload();
}

// ── Webhook ───────────────────────────────────────────────────────────────

/** El cobro Bre-B al que se refiere un aviso de Kushki, o null. */
export async function findBreBChargeForWebhook(refs: {
  chargeId: string | null;
  token: string | null;
  paymentId: string | null;
  transactionReference: string | null;
  ticketNumber: string | null;
}): Promise<BreBCharge | null> {
  if (refs.chargeId) {
    const byId = await db.breBCharge.findUnique({ where: { id: refs.chargeId } });
    if (byId) return byId;
  }
  if (refs.token) {
    const byToken = await db.breBCharge.findUnique({ where: { token: refs.token } });
    if (byToken) return byToken;
  }
  if (refs.paymentId) {
    const byPayment = await db.breBCharge.findUnique({ where: { paymentId: refs.paymentId } });
    if (byPayment) return byPayment;
  }
  const wheres: Prisma.BreBChargeWhereInput[] = [
    ...(refs.transactionReference ? [{ transactionReference: refs.transactionReference }] : []),
    ...(refs.ticketNumber ? [{ ticketNumber: refs.ticketNumber }] : []),
  ];
  for (const where of wheres) {
    const rows = await db.breBCharge.findMany({ where, take: 2 });
    // Una referencia que casa con dos cobros no identifica a ninguno.
    if (rows.length === 1) return rows[0];
  }
  return null;
}

export type BreBWebhookOutcome = "approved" | "closed" | "review" | "ignored";

/**
 * Aplica un aviso de Kushki YA AUTENTICADO sobre su cobro. Idempotente: el
 * mismo aviso dos veces no salda dos veces (mismo `eventId` por cobro).
 */
export async function handleBreBWebhookEvent(
  charge: BreBCharge,
  event: BreBWebhookEvent,
  raw: unknown,
  source: "webhook" | "mock" = "webhook",
): Promise<BreBWebhookOutcome> {
  if (event.status === "pending") return "ignored";
  // Lo que el aviso dice de sí mismo tiene que ser de ESTE cobro.
  const foreign =
    (event.metadata.chargeId && event.metadata.chargeId !== charge.id) ||
    (event.metadata.paymentId && charge.paymentId && event.metadata.paymentId !== charge.paymentId) ||
    (event.metadata.paymentLinkId && charge.paymentLinkId && event.metadata.paymentLinkId !== charge.paymentLinkId) ||
    (event.token && charge.token && event.token !== charge.token);
  if (event.status === "approved") {
    if (foreign) {
      await flagForReview(charge, "reference_mismatch", { amountCents: event.amountCents, currency: event.currency }, source);
      return "review";
    }
    if (event.amountCents == null && charge.token && charge.mode !== "mock") {
      // El aviso no trae el monto: manda la consulta de estado (autenticada
      // con la llave privada). Se pregunta aunque el cobro ya esté cerrado:
      // una aprobación tardía sobre un QR cancelado no se puede perder.
      const gateway = await gatewayOf(charge);
      let result: BreBStatusResult | null = null;
      if (gateway) {
        try {
          result = await gateway.status(charge.token);
        } catch (err) {
          console.warn("[bre-b] status for webhook failed", { chargeId: charge.id, failure: breBFailureLabel(err) });
        }
      }
      if (result?.status === "approved") {
        await applyApproval(charge, result, "status", { source: "status", status: result.status });
      } else {
        // Aviso de "aprobado" que la consulta no respalda: a revisión.
        await flagForReview(charge, "amount_unverified", { amountCents: null, currency: event.currency }, source);
      }
      const after = await db.breBCharge.findUnique({ where: { id: charge.id }, select: { status: true } });
      return after?.status === "approved" ? "approved" : "review";
    }
    await applyApproval(charge, event, source, raw);
    const after = await db.breBCharge.findUnique({ where: { id: charge.id }, select: { status: true } });
    return after?.status === "approved" ? "approved" : "review";
  }
  if (foreign || !isBreBOpenState(charge.status) || reviewLocked(charge)) return "ignored";
  await closeCharge(charge.id, "declined", "provider_declined");
  return "closed";
}

/**
 * Un aviso Bre-B aprobado que no casa con ningún cobro, de un comercio que
 * sí es nuestro: no hay qué saldar, pero la plata pudo entrar. Queda en el
 * registro de webhooks y en la auditoría para conciliarlo; nunca se pierde.
 */
export async function recordUnmatchedBreBEvent(input: {
  restaurantId: string;
  status: string;
  amountCents: number | null;
  token: string | null;
  transactionReference: string | null;
  ticketNumber: string | null;
}): Promise<boolean> {
  const key = input.transactionReference ?? input.ticketNumber ?? input.token;
  if (!key) return false;
  const created = await db.kushkiWebhookEvent.createMany({
    data: [
      {
        eventId: `breb:unmatched:${key}:${input.status}`,
        type: "bre_b.unmatched",
        restaurantId: input.restaurantId,
        payload: {
          status: input.status,
          amountCents: input.amountCents,
          token: input.token,
          transactionReference: input.transactionReference,
          ticketNumber: input.ticketNumber,
        },
        processedAt: new Date(),
        error: "bre_b_unmatched",
      },
    ],
    skipDuplicates: true,
  });
  if (created.count > 0) {
    await db.auditEvent.create({
      data: {
        restaurantId: input.restaurantId,
        actorEmail: "kushki",
        actorRole: "system",
        kind: "payment.bre_b_unmatched",
        targetType: "restaurant",
        targetId: input.restaurantId,
        summary: "Llegó un aviso de Bre-B que no corresponde a ningún cobro registrado; requiere conciliación.",
        diff: {
          status: input.status,
          amountCents: input.amountCents,
          transactionReference: input.transactionReference,
          ticketNumber: input.ticketNumber,
        },
      },
    });
  }
  return created.count > 0;
}

// ── Barrido y demo ────────────────────────────────────────────────────────

/**
 * Barrido de respaldo (cron cada 10 min): los QR vencidos que nadie está
 * mirando se consultan y se cierran, para que una cuenta no quede bloqueada
 * por un Bre-B abandonado; los inciertos se vuelven a consultar por si
 * Kushki ya responde.
 */
export async function sweepBreBCharges(limit = 50): Promise<{ checked: number; resolved: number }> {
  const now = Date.now();
  const due = await db.breBCharge.findMany({
    where: {
      OR: [
        { status: "active", expiresAt: { lt: new Date(now - BRE_B_EXPIRY_GRACE_MS) } },
        { status: "creating", createdAt: { lt: new Date(now - BRE_B_CREATING_STALE_MS) } },
        { status: "uncertain", createdAt: { gt: new Date(now - 48 * 3600_000) } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let resolved = 0;
  for (const { id } of due) {
    try {
      const after = await checkBreBCharge(id, { force: true });
      if (after && !isBreBOpenState(after.status)) resolved++;
    } catch (err) {
      console.error("[bre-b] sweep failed", { chargeId: id, error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return { checked: due.length, resolved };
}

export type BreBMockDecision = "approved" | "declined" | "wrong_amount";

/**
 * Modo demo: hace de "app del banco". Arma un aviso como el de Kushki y lo
 * pasa por el MISMO camino de verificación (por eso "otro monto" termina en
 * revisión y no en aprobado). Nunca en producción ni sobre un cobro real.
 */
export async function simulateBreBMock(
  chargeId: string,
  decision: BreBMockDecision,
): Promise<BreBWebhookOutcome | null> {
  if (process.env.NODE_ENV === "production") return null;
  const charge = await db.breBCharge.findUnique({ where: { id: chargeId } });
  if (!charge || charge.mode !== "mock") return null;
  return handleBreBWebhookEvent(
    charge,
    {
      status: decision === "declined" ? "declined" : "approved",
      amountCents: decision === "wrong_amount" ? charge.amountCents + 100 : charge.amountCents,
      currency: charge.currency,
      token: charge.token,
      transactionReference: null,
      ticketNumber: null,
      metadata: {
        chargeId: charge.id,
        paymentId: charge.paymentId,
        orderId: null,
        paymentLinkId: charge.paymentLinkId,
      },
      merchantId: null,
    },
    { source: "mock", decision },
    "mock",
  );
}
