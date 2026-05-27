import { NextResponse } from "next/server";
import {
  processKushkiWebhook,
  type KushkiWebhookKind,
} from "@/lib/payments/webhookHandler";
import { verifyKushkiSignature } from "@/lib/payments/kushki/webhooks";

/**
 * Kushki webhook receiver.
 *
 * Verifies the HMAC signature, then hands off to the shared processor
 * (src/lib/payments/webhookHandler.ts). The handler is idempotent so
 * Kushki's retries are safe.
 *
 * Mock mode bypasses signature verification — the mock provider calls into
 * processKushkiWebhook directly via subscribeMockWebhook (wired from the
 * server entrypoint that needs terminal callbacks).
 */

export async function POST(req: Request) {
  const raw = await req.text();
  const verify = verifyKushkiSignature(raw, req.headers);
  if (!verify.ok) {
    return NextResponse.json(
      { error: "invalid_signature", reason: verify.reason },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isPayload(payload)) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
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
