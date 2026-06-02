import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { processKushkiWebhook } from "@/lib/payments/webhookHandler";
import { verifyKushkiSignature } from "@/lib/payments/kushki/webhooks";
import { getRestaurantWebhookSecret } from "@/lib/payments";

/**
 * Webhook del **Cloud Terminal API** (datáfono físico vía cloud — infra
 * billpocket). DISTINTO del webhook principal (/api/webhooks/kushki): el
 * Cloud Terminal manda otra forma de payload (`result: "aprobada"` …) y
 * no necesariamente con nuestros eventId/type, así que lo normalizamos
 * acá y lo metemos al mismo `processKushkiWebhook` (que settlea el Payment
 * por paymentId, recomputa la orden y activa rounds).
 *
 * Matching: mandamos `uniqueReference = Payment.id` en el push, y el
 * webhook lo devuelve — así encontramos el pago. La firma se verifica con
 * el mismo HMAC (X-Kushki-Signature) que el resto.
 *
 * ⚠️ Los nombres de campos del payload del Cloud Terminal no están 100%
 * documentados públicamente; extraemos defensivamente de varios alias y
 * logueamos el body crudo para ajustar cuando se pruebe con un cobro real.
 */

export async function POST(req: Request) {
  const raw = await req.text();
  console.log("[kushki/cloud-terminal] webhook raw", raw.slice(0, 800));

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // —— Referencia nuestra (= Payment.id) que mandamos como uniqueReference.
  const str = (v: unknown): string =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  const reference =
    str(body.uniqueReference) ||
    str(body.identifier) ||
    str(body.clientTransactionId) ||
    str(body.client_transaction_id) ||
    str(body.reference);

  // —— Resultado: aprobado vs rechazado.
  const resultRaw = (
    str(body.result) ||
    str(body.status) ||
    str(body.transactionStatus) ||
    str(body.transaction_status)
  ).toLowerCase();
  const approved = ["aprobada", "approved", "approval", "completed", "success"].includes(
    resultRaw,
  );

  // —— Ref de la transacción del lado de Kushki (para el espejo).
  const providerRef =
    str(body.transactionReference) ||
    str(body.transaction_reference) ||
    str(body.ticketNumber) ||
    str(body.ticket_number) ||
    str(body.id) ||
    reference;

  const message =
    str(body.message) ||
    str(body.responseText) ||
    str((body.processor as Record<string, unknown> | undefined)?.message) ||
    undefined;

  if (!reference) {
    console.error("[kushki/cloud-terminal] webhook sin referencia", body);
    return NextResponse.json({ error: "no_reference" }, { status: 400 });
  }

  // Resolver el restaurante (para el secret por-comercio) vía el pago.
  const payment = await db.payment.findUnique({
    where: { id: reference },
    select: { id: true, order: { select: { restaurantId: true } } },
  });
  const restaurantId = payment?.order.restaurantId ?? null;
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

  if (!payment) {
    // Firma OK pero no encontramos el pago — 200 para que no reintente
    // infinito (puede ser un cobro hecho fuera de MESAPAY).
    console.warn("[kushki/cloud-terminal] pago no encontrado", reference);
    return NextResponse.json({ ok: true, status: "no_payment" });
  }

  const result = await processKushkiWebhook({
    // eventId estable para idempotencia: la tx de Kushki + el resultado.
    eventId: `cloudterm:${providerRef}:${approved ? "ok" : "no"}`,
    type: approved ? "terminal.approved" : "terminal.declined",
    restaurantId: restaurantId ?? undefined,
    paymentId: payment.id,
    providerRef,
    message,
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
