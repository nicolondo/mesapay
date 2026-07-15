import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  processKushkiWebhook,
  type KushkiWebhookKind,
} from "@/lib/payments/webhookHandler";
import {
  verifyKushkiSignature,
  verifyKushkiWebhookFlexible,
} from "@/lib/payments/kushki/webhooks";
import { getRestaurantWebhookSecret } from "@/lib/payments";

/**
 * Kushki webhook receiver — ÚNICO endpoint para todos los estados de
 * transacción (tarjeta, PSE), como pide Kushki ("una sola URL").
 *
 * Maneja DOS formas de payload:
 *   A. Formato interno normalizado ({ eventId, type: "charge.approved", … }):
 *      lo produce el provider mock/tests. Se procesa como antes.
 *   B. Payload REAL de Kushki (nested `metadata`, `ticketNumber`,
 *      `status: "APPROVAL"` …): se normaliza acá y se despacha al mismo
 *      `processKushkiWebhook` (idempotente). Ver `handleRealKushki`.
 *
 * Ping de validación de la URL (cuerpo vacío / sin referencia): responde 200
 * sin pedir firma, para que Kushki acepte la URL en su consola.
 *
 * Matching del pago: al cobrar mandamos nuestro `Payment.id` dentro de
 * `metadata` → Kushki lo devuelve; si no viene, casamos por
 * `transactionReference`/`ticketNumber` (= Payment.providerRef /
 * KushkiTransaction.kushkiTxId) o por el último pago pendiente de la orden.
 *
 * ⚠️ Los nombres EXACTOS de los campos del payload real de Kushki no están
 * 100% documentados públicamente: extraemos defensivamente de varios alias y
 * logueamos el body crudo para ajustar con la primera transacción real.
 */

const KNOWN_KINDS: KushkiWebhookKind[] = [
  "charge.approved",
  "charge.declined",
  "terminal.approved",
  "terminal.declined",
  "pse.approved",
  "pse.declined",
  "dispersion.completed",
  "dispersion.failed",
  "merchant.activated",
  "merchant.rejected",
];

export async function POST(req: Request) {
  const raw = await req.text();

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    // Cuerpo vacío / no-objeto → ping de validación de la URL. 200 para que
    // Kushki acepte la URL.
    return NextResponse.json({ ok: true });
  }

  // ── Path A: formato interno normalizado (mock/tests). Igual que antes. ──
  if (isNormalizedPayload(payload)) {
    return handleNormalized(raw, payload, req.headers);
  }

  // ── Path B: payload REAL de Kushki. ──
  return handleRealKushki(raw, payload as Record<string, unknown>, req.headers);
}

/** Payload interno ya normalizado por el provider mock. */
function isNormalizedPayload(x: unknown): x is {
  eventId: string;
  type: KushkiWebhookKind;
  restaurantId?: string;
  paymentId?: string;
  orderId?: string;
  providerRef?: string;
  amountCents?: number;
  message?: string;
} {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.eventId !== "string" || !o.eventId) return false;
  if (typeof o.type !== "string") return false;
  return KNOWN_KINDS.includes(o.type as KushkiWebhookKind);
}

/** Procesa el formato interno normalizado (comportamiento previo). */
async function handleNormalized(
  raw: string,
  payload: {
    eventId: string;
    type: KushkiWebhookKind;
    restaurantId?: string;
    paymentId?: string;
    orderId?: string;
    providerRef?: string;
    amountCents?: number;
    message?: string;
  },
  headers: Headers,
): Promise<Response> {
  let restaurantId: string | null = payload.restaurantId ?? null;
  if (!restaurantId && payload.paymentId) {
    const p = await db.payment.findUnique({
      where: { id: payload.paymentId },
      select: { order: { select: { restaurantId: true } } },
    });
    restaurantId = p?.order.restaurantId ?? null;
  }
  if (!restaurantId && payload.orderId) {
    const o = await db.order.findUnique({
      where: { id: payload.orderId },
      select: { restaurantId: true },
    });
    restaurantId = o?.restaurantId ?? null;
  }

  const restaurantSecret = restaurantId
    ? await getRestaurantWebhookSecret(restaurantId)
    : null;
  const verify = verifyKushkiSignature(raw, headers, restaurantSecret);
  if (!verify.ok) {
    return NextResponse.json(
      { error: "invalid_signature", reason: verify.reason },
      { status: 401 },
    );
  }

  const result = await processKushkiWebhook(payload);
  if (result.status === "error") {
    return NextResponse.json(
      { error: "processing_error", message: result.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, status: result.status });
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Normaliza y despacha el payload real de Kushki. */
async function handleRealKushki(
  raw: string,
  body: Record<string, unknown>,
  headers: Headers,
): Promise<Response> {
  // Log del crudo para poder ajustar los alias con la primera transacción real.
  console.log("[kushki/webhook] real payload", raw.slice(0, 1000));

  // Nuestra metadata (mandamos { orderId, paymentId } al cobrar) — puede venir
  // en la raíz, bajo `metadata`, o bajo `transaction.metadata`.
  const meta = asObj(body.metadata);
  const tx = asObj(body.transaction);
  const txMeta = asObj(tx.metadata);
  const paymentIdHint =
    str(meta.paymentId) || str(txMeta.paymentId) || str(body.paymentId);
  const orderIdHint =
    str(meta.orderId) || str(txMeta.orderId) || str(body.orderId);
  const txRef =
    str(body.transactionReference) ||
    str(body.transaction_reference) ||
    str(tx.transactionReference) ||
    str(body.ticketNumber) ||
    str(body.ticket_number) ||
    str(tx.ticketNumber);

  // Estado.
  const statusRaw = (
    str(body.status) ||
    str(body.transactionStatus) ||
    str(body.transaction_status) ||
    str(tx.status) ||
    str(body.result)
  ).toLowerCase();
  const approved = [
    "approval",
    "approved",
    "aprobada",
    "aprobado",
    "completed",
    "success",
  ].includes(statusRaw);
  const declined = [
    "declined",
    "rechazada",
    "rechazado",
    "failed",
    "failure",
    "error",
  ].includes(statusRaw);

  // Sin ninguna referencia → ping de validación de la URL → 200.
  if (!paymentIdHint && !orderIdHint && !txRef) {
    console.log("[kushki/webhook] handshake / validación de URL — 200");
    return NextResponse.json({ ok: true });
  }
  // Estado no terminal (INITIALIZED/pending) → ack, nada que liquidar aún.
  if (!approved && !declined) {
    return NextResponse.json({ ok: true, ignored: statusRaw || "no_status" });
  }

  // Resolver el Payment: metadata.paymentId → providerRef/txRef → orden.
  let paymentId: string | null = null;
  let restaurantId: string | null = null;

  if (paymentIdHint) {
    const p = await db.payment.findUnique({
      where: { id: paymentIdHint },
      select: { id: true, order: { select: { restaurantId: true } } },
    });
    if (p) {
      paymentId = p.id;
      restaurantId = p.order.restaurantId;
    }
  }
  if (!paymentId && txRef) {
    const p = await db.payment.findFirst({
      where: { providerRef: txRef },
      select: { id: true, order: { select: { restaurantId: true } } },
    });
    if (p) {
      paymentId = p.id;
      restaurantId = p.order.restaurantId;
    } else {
      const kt = await db.kushkiTransaction.findUnique({
        where: { kushkiTxId: txRef },
        select: { paymentId: true },
      });
      if (kt?.paymentId) {
        const kp = await db.payment.findUnique({
          where: { id: kt.paymentId },
          select: { id: true, order: { select: { restaurantId: true } } },
        });
        if (kp) {
          paymentId = kp.id;
          restaurantId = kp.order.restaurantId;
        }
      }
    }
  }
  if (!paymentId && orderIdHint) {
    // Último recurso: el pago Kushki pendiente más reciente de esa orden.
    const p = await db.payment.findFirst({
      where: {
        orderId: orderIdHint,
        status: "pending",
        method: {
          in: [
            "kushki_pse",
            "kushki_card",
            "kushki_apple_pay",
            "kushki_card_terminal",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, order: { select: { restaurantId: true } } },
    });
    if (p) {
      paymentId = p.id;
      restaurantId = p.order.restaurantId;
    }
  }

  if (!paymentId) {
    console.warn("[kushki/webhook] no pude casar el pago", {
      paymentIdHint,
      orderIdHint,
      txRef,
      statusRaw,
    });
    // Ack 200 para que Kushki no reintente infinito; queda en logs.
    return NextResponse.json({ ok: true, unmatched: true });
  }

  // Firma (secret del comercio si está, si no el global del partner).
  const secret = restaurantId
    ? await getRestaurantWebhookSecret(restaurantId)
    : null;
  const verify = verifyKushkiWebhookFlexible(raw, headers, secret);
  if (!verify.ok) {
    return NextResponse.json(
      { error: "invalid_signature", reason: verify.reason },
      { status: 401 },
    );
  }

  const amountCents =
    typeof body.amountCents === "number" ? body.amountCents : undefined;
  const kind: KushkiWebhookKind = approved
    ? "charge.approved"
    : "charge.declined";
  const result = await processKushkiWebhook({
    // eventId estable para la idempotencia (KushkiWebhookEvent).
    eventId: `kushki:${txRef || paymentId}:${approved ? "ok" : "no"}`,
    type: kind,
    paymentId,
    restaurantId: restaurantId ?? undefined,
    providerRef: txRef || undefined,
    amountCents,
    raw: body,
  });
  if (result.status === "error") {
    return NextResponse.json(
      { error: "processing_error", message: result.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, status: result.status });
}
