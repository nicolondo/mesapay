import "server-only";
import { NextResponse } from "next/server";
import type { BreBCharge, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  BreBContractError,
  parseBreBWebhook,
  readBreBWebhookMerchantKey,
  readBreBWebhookReferences,
  type BreBWebhookEvent,
} from "../kushki/breB";
import { verifyKushkiWebhookFlexible } from "../kushki/webhooks";
import { readBreBWebhookSecret } from "./credentials";
import {
  checkBreBCharge,
  findBreBChargeForWebhook,
  handleBreBWebhookEvent,
  recordUnmatchedBreBEvent,
} from "./service";

/**
 * Avisos de Kushki para Bre-B en `/api/webhooks/kushki` (Kushki pide una
 * sola URL por comercio; el comercio Bre-B apunta a la misma).
 *
 * Bre-B cobra con OTRO comercio de Kushki, así que acá cambian dos cosas
 * respecto de tarjeta/PSE:
 *
 *   1. A QUIÉN se le cree: la firma se verifica con la firma de webhook del
 *      comercio Bre-B del restaurante (`kushkiBreBWebhookSecretEnc`), nunca
 *      con la del comercio de tarjeta. Sin ella cae al secreto global del
 *      .env, con la misma política por modo que el resto
 *      (`verifyKushkiWebhookFlexible`: en producción el secreto es obligatorio).
 *   2. CÓMO se casa: por el `BreBCharge` (nuestro id en `metadata`, el token,
 *      la referencia) y, si no hay cobro, por el comercio Bre-B (header
 *      `X-Kushki-Key` / `merchantId`) para que un aprobado huérfano quede
 *      registrado y no se pierda.
 *
 * Un aviso que no pasa la firma NO se aplica, pero dispara una consulta de
 * estado (autenticada con la llave privada, con su tope de frecuencia): si
 * de verdad pasó algo, lo dice Kushki, no quien mandó el aviso.
 */

function signatureFailure(reason: string): Response {
  return NextResponse.json({ error: "invalid_signature", reason }, { status: 401 });
}

async function breBSecretFor(restaurantId: string): Promise<string | null> {
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { kushkiBreBWebhookSecretEnc: true },
  });
  return readBreBWebhookSecret(tenant);
}

async function applyVerified(charge: BreBCharge, body: unknown): Promise<Response> {
  let event: BreBWebhookEvent;
  try {
    event = parseBreBWebhook(body);
  } catch (err) {
    if (!(err instanceof BreBContractError)) throw err;
    // El aviso es auténtico pero no se entiende (contrato): no se adivina.
    // Manda la consulta de estado.
    console.warn("[bre-b/webhook] aviso que no se pudo leer", { chargeId: charge.id, reason: err.reason });
    await checkBreBCharge(charge.id, { force: true });
    return NextResponse.json({ ok: true, status: "unreadable_checked" });
  }
  const outcome = await handleBreBWebhookEvent(charge, event, body);
  return NextResponse.json({ ok: true, status: outcome });
}

/**
 * Payload REAL de Kushki. Devuelve la respuesta si el aviso es de Bre-B;
 * `null` si no lo es (sigue el camino de tarjeta/PSE de siempre).
 */
export async function tryHandleBreBWebhook(
  raw: string,
  body: Record<string, unknown>,
  headers: Headers,
): Promise<Response | null> {
  const refs = readBreBWebhookReferences(body);
  const charge = await findBreBChargeForWebhook(refs);
  if (charge) {
    const verify = verifyKushkiWebhookFlexible(raw, headers, await breBSecretFor(charge.restaurantId));
    if (!verify.ok) {
      void checkBreBCharge(charge.id).catch(() => {});
      return signatureFailure(verify.reason);
    }
    return applyVerified(charge, body);
  }

  // Sin cobro que casar: ¿el aviso es de un comercio Bre-B nuestro?
  const merchantKey = readBreBWebhookMerchantKey(headers);
  const where: Prisma.RestaurantWhereInput[] = [
    ...(merchantKey ? [{ kushkiBreBPublicKey: merchantKey }] : []),
    ...(refs.merchantId
      ? [{ kushkiBreBMerchantId: refs.merchantId }, { kushkiBreBPublicKey: refs.merchantId }]
      : []),
  ];
  if (where.length === 0) return null;
  const tenants = await db.restaurant.findMany({ where: { OR: where }, select: { id: true }, take: 2 });
  // Sin comercio Bre-B (o ambiguo): no es nuestro caso.
  if (tenants.length !== 1) return null;
  const restaurantId = tenants[0].id;
  const verify = verifyKushkiWebhookFlexible(raw, headers, await breBSecretFor(restaurantId));
  if (!verify.ok) return signatureFailure(verify.reason);

  let event: BreBWebhookEvent;
  try {
    event = parseBreBWebhook(body);
  } catch (err) {
    if (!(err instanceof BreBContractError)) throw err;
    // Handshake / ping de validación del comercio Bre-B: nada que registrar.
    return NextResponse.json({ ok: true, status: "ignored" });
  }
  if (event.status !== "approved") return NextResponse.json({ ok: true, status: "ignored" });
  await recordUnmatchedBreBEvent({
    restaurantId,
    status: event.status,
    amountCents: event.amountCents,
    token: event.token,
    transactionReference: event.transactionReference,
    ticketNumber: event.ticketNumber,
  });
  return NextResponse.json({ ok: true, status: "unmatched_recorded" });
}

/**
 * Formato interno normalizado (`{ eventId, type, paymentId, amountCents }`,
 * el del mock y los tests). Un pago Bre-B NUNCA se salda por el camino
 * genérico: pasa por la misma verificación (firma del comercio Bre-B,
 * referencia, monto). Devuelve `null` si el pago no es Bre-B.
 */
export async function tryHandleNormalizedBreB(
  raw: string,
  payload: { type: string; paymentId?: string; providerRef?: string; amountCents?: number },
  headers: Headers,
): Promise<Response | null> {
  if (!payload.paymentId) return payload.type.startsWith("bre_b.") ? NextResponse.json({ error: "invalid_reference" }, { status: 400 }) : null;
  const charge = await db.breBCharge.findUnique({ where: { paymentId: payload.paymentId } });
  if (!charge) {
    return payload.type.startsWith("bre_b.") ? NextResponse.json({ error: "invalid_reference" }, { status: 400 }) : null;
  }
  const verify = verifyKushkiWebhookFlexible(raw, headers, await breBSecretFor(charge.restaurantId));
  if (!verify.ok) return signatureFailure(verify.reason);
  const outcome = await handleBreBWebhookEvent(
    charge,
    {
      status: payload.type.endsWith(".approved") ? "approved" : "declined",
      amountCents: typeof payload.amountCents === "number" ? payload.amountCents : null,
      currency: null,
      token: null,
      transactionReference: payload.providerRef ?? null,
      ticketNumber: null,
      metadata: { chargeId: null, paymentId: payload.paymentId, orderId: null, paymentLinkId: null },
      merchantId: null,
    },
    payload,
  );
  return NextResponse.json({ ok: true, status: outcome });
}
