import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { verifyKushkiSignature } from "@/lib/payments/kushki/webhooks";
import {
  addMonthsIso,
  applyRecurringCharge,
  markRecurringChargeFailed,
} from "@/lib/billing/subscription";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Listener de COBROS RECURRENTES de la suscripción (Kushki One-click &
 * scheduled payments, cuenta de PLATAFORMA).
 *
 * URL a configurar en la Consola de Kushki (merchant de cobro de plataforma):
 *   https://mesapay.co/api/webhooks/kushki-subscription
 *
 * Flujo:
 *   1. Kushki primero valida la URL con una petición que solo espera un 200
 *      (sin firma). Cualquier request sin evento procesable → 200 (handshake).
 *   2. Logueamos headers + body para descubrir las "llaves" que Kushki manda
 *      en los headers de los eventos reales (VERIFY vs sandbox).
 *   3. Parsear el payload (tolerante a variantes de nombres).
 *   4. Verificar firma (KUSHKI_BILLING_WEBHOOK_SECRET, fallback al global).
 *      Durante el setup NO bloquea — loguea y sigue — hasta confirmar headers.
 *   5. Resolver el BillingSubscription por kushkiSubscriptionId.
 *   6. Idempotencia: si ya registramos ese ticket (providerRef), no repetir.
 *   7. Aprobado → applyRecurringCharge (avanza período +1 mes, reactiva).
 *      Rechazado → markRecurringChargeFailed (NO avanza; el cron de
 *      vencimiento suspende cuando el período vence).
 *
 * Devolvemos 200 incluso para eventos que ignoramos (suscripción no
 * encontrada, estado indeterminado), para que Kushki no reintente en bucle.
 * Solo devolvemos 5xx ante un error de procesamiento real (para que reintente).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Busca una clave (varias variantes) en el objeto y en contenedores comunes. */
function deepFind(obj: Json, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const containers = [obj, obj.subscription, obj.transaction, obj.data, obj.payload];
  for (const c of containers) {
    if (!c || typeof c !== "object") continue;
    for (const k of keys) {
      const v = c[k];
      if (typeof v === "string" && v) return v;
      if (typeof v === "number") return String(v);
      if (typeof v === "boolean") return String(v);
    }
  }
  return undefined;
}

export async function POST(req: Request) {
  const raw = await req.text();

  // Logueamos headers + body para DESCUBRIR el formato exacto de Kushki: las
  // "llaves" que manda en los headers de cada evento real. Temporal para el
  // setup — una vez confirmados los nombres, endurecemos la verificación.
  const headerDump: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headerDump[k] = v;
  });
  // JSON en UNA línea: si logueamos el objeto, Node lo parte en varias y el
  // grep solo agarra la primera (no se ven los headers reales de Kushki).
  console.log("[billing/webhook] headers", JSON.stringify(headerDump));
  console.log("[billing/webhook] body", raw.slice(0, 1000) || "(empty)");

  // Parse tolerante. Kushki manda PRIMERO una petición de VALIDACIÓN de la URL
  // que solo espera un 200 (puede venir vacía o sin evento). Cualquier cosa
  // que no sea un evento procesable → 200 (handshake), nunca 4xx.
  let payload: Json = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  // VERIFY vs sandbox: confirmar los nombres exactos del payload real.
  const subscriptionId = deepFind(payload, ["subscriptionId", "subscription_id"]);
  const providerRef =
    deepFind(payload, [
      "ticketNumber",
      "transactionReference",
      "transactionId",
      "transaction_reference",
    ]) ?? null;
  const rawStatus =
    deepFind(payload, [
      "status",
      "transactionStatus",
      "ticketStatus",
      "transaction_status",
    ]) ?? "";
  const approvedFlag = deepFind(payload, ["approved"]);

  const s = rawStatus.toUpperCase();
  const isApproved =
    s.includes("APPROV") || approvedFlag === "true";
  const isDeclined =
    s.includes("DECLIN") || s.includes("FAIL") || approvedFlag === "false";

  console.log("[billing/webhook] recurring charge", {
    subscriptionId,
    providerRef,
    rawStatus,
    isApproved,
    isDeclined,
  });

  if (!subscriptionId) {
    // Petición de validación / handshake de Kushki (sin evento): responder 200.
    console.log("[billing/webhook] handshake / validación de URL — 200");
    return NextResponse.json({ ok: true });
  }

  // Verificación de firma. Kushki manda las llaves en los headers de los
  // eventos reales; mientras confirmamos los nombres exactos (ver el log de
  // headers de arriba), NO bloqueamos — logueamos y seguimos — para no trabar
  // la integración. VERIFY vs sandbox: endurecer a 401 cuando se conozcan los
  // headers reales de Kushki.
  const verify = verifyKushkiSignature(
    raw,
    req.headers,
    env.KUSHKI_BILLING_WEBHOOK_SECRET ?? null,
  );
  if (!verify.ok) {
    console.warn(
      "[billing/webhook] firma no verificada — procesando igual durante setup:",
      verify.reason,
    );
  }

  // 3. Resolver la suscripción.
  const sub = await db.billingSubscription.findFirst({
    where: { kushkiSubscriptionId: subscriptionId },
    select: {
      restaurantId: true,
      amountCents: true,
      currency: true,
      restaurant: { select: { name: true, periodEndsAt: true } },
    },
  });
  if (!sub) {
    console.warn("[billing/webhook] suscripción no encontrada", { subscriptionId });
    return NextResponse.json({ ok: true, ignored: "unknown_subscription" });
  }

  // Estado indeterminado → ni cobramos ni suspendemos.
  if (!isApproved && !isDeclined) {
    console.warn("[billing/webhook] estado indeterminado — ignorado", { rawStatus });
    return NextResponse.json({ ok: true, ignored: "unknown_status" });
  }

  try {
    if (isApproved) {
      // 4. Idempotencia por ticket: no cobrar dos veces el mismo.
      if (providerRef) {
        const dup = await db.membershipPayment.findFirst({
          where: { restaurantId: sub.restaurantId, providerRef },
          select: { id: true },
        });
        if (dup) {
          return NextResponse.json({ ok: true, status: "already_processed" });
        }
      }

      // Nuevo período = (max(período actual, ahora)) + 1 mes.
      const now = new Date();
      const base =
        sub.restaurant.periodEndsAt && sub.restaurant.periodEndsAt > now
          ? sub.restaurant.periodEndsAt
          : now;
      const periodEnd = new Date(addMonthsIso(base, 1));

      await applyRecurringCharge({
        restaurantId: sub.restaurantId,
        amountCents: sub.amountCents,
        currency: sub.currency,
        providerRef,
        periodStart: now,
        periodEnd,
      });

      await recordAuditEvent({
        kind: "subscription.charge.recurring",
        restaurantId: sub.restaurantId,
        target: { type: "restaurant", id: sub.restaurantId },
        summary: `Cobro recurrente aprobado de ${sub.restaurant.name} · período hasta ${periodEnd.toISOString().slice(0, 10)}`,
      });
      return NextResponse.json({ ok: true, status: "approved" });
    }

    // Rechazado.
    await markRecurringChargeFailed(sub.restaurantId);
    await recordAuditEvent({
      kind: "subscription.charge.failed",
      restaurantId: sub.restaurantId,
      target: { type: "restaurant", id: sub.restaurantId },
      summary: `Cobro recurrente fallido de ${sub.restaurant.name}`,
    });
    return NextResponse.json({ ok: true, status: "declined" });
  } catch (err) {
    // Error real de procesamiento → 500 para que Kushki reintente
    // (la idempotencia por providerRef hace seguro el reintento).
    console.error("[billing/webhook] processing error", err);
    return NextResponse.json(
      { error: "processing_error" },
      { status: 500 },
    );
  }
}
