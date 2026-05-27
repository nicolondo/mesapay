import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  processKushkiWebhook,
  type KushkiWebhookKind,
} from "@/lib/payments/webhookHandler";
import { verifyKushkiSignature } from "@/lib/payments/kushki/webhooks";
import { getRestaurantWebhookSecret } from "@/lib/payments";

/**
 * Kushki webhook receiver.
 *
 * Flow:
 *   1. Parse JSON (sin trust — sólo para routing)
 *   2. Resolver restaurantId (directo del payload o vía paymentId/orderId)
 *   3. Cargar el webhook secret del comercio (fallback al env global)
 *   4. Verificar firma HMAC
 *   5. Procesar evento
 *
 * Por qué parseamos antes de verificar: necesitamos saber qué secret
 * usar. Un atacante puede mandar payload con restaurantId arbitrario,
 * pero la firma fallará porque no conoce el secret de ese restaurante.
 *
 * Mock mode bypasses signature verification — el provider mock llama a
 * processKushkiWebhook directamente vía subscribeMockWebhook.
 */

export async function POST(req: Request) {
  const raw = await req.text();

  // Parse defensivo antes de verificar — necesitamos saber a qué
  // restaurante pertenece el evento para resolver su secret.
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isPayload(payload)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  // Resolver el restaurantId. Distintos eventos traen distintos
  // identificadores (charge eventos → paymentId, merchant eventos →
  // restaurantId directo, etc.).
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

  const verify = verifyKushkiSignature(raw, req.headers, restaurantSecret);
  if (!verify.ok) {
    return NextResponse.json(
      { error: "invalid_signature", reason: verify.reason },
      { status: 401 },
    );
  }

  const result = await processKushkiWebhook(payload);
  if (result.status === "error") {
    // Return 500 so Kushki retries. Idempotency on our side makes that safe.
    return NextResponse.json(
      { error: "processing_error", message: result.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, status: result.status });
}

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

function isPayload(x: unknown): x is {
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
  if (!KNOWN_KINDS.includes(o.type as KushkiWebhookKind)) return false;
  return true;
}
