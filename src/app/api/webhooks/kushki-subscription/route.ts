import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import {
  addMonthsIso,
  applyRecurringCharge,
  markRecurringChargeFailed,
} from "@/lib/billing/subscription";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Listener de COBROS RECURRENTES de la suscripción (Kushki "Webhook card
 * subscriptions", cuenta de PLATAFORMA).
 *
 * URL a configurar en la Consola de Kushki (merchant de cobro de plataforma):
 *   https://mesapay.co/api/webhooks/kushki-subscription
 *
 * Payload (doc Kushki — recurring-payments/webhook-card-subscriptions):
 *   {
 *     "name": "succesfullCharge" | "declinedCharge" | "failedRetry"
 *           | "lastRetry" | "subscriptionDelete" | "subscriptionApproved",
 *     "event": { subscriptionId, ticketNumber, transactionReference,
 *                approvalCode, amount, ... }
 *   }
 *
 * Firma (doc Kushki — notifications/overview#autenticación). Headers:
 *   X-Kushki-Key            = ID del comercio
 *   X-Kushki-Id             = timestamp Unix (ms)
 *   X-Kushki-Signature      = HMAC_SHA256( secret, JSON.stringify(body)+"."+X-Kushki-Id ) hex
 *   X-Kushki-SimpleSignature= HMAC_SHA256( secret, X-Kushki-Id ) hex
 * `secret` = "Webhook signature ID" del merchant en la Consola
 *            (env KUSHKI_BILLING_WEBHOOK_SECRET, fallback al global).
 *
 * Política: si el secret está configurado, la firma es OBLIGATORIA (401 si no
 * matchea). Sin secret → bypass con warning (fase de pruebas). La petición de
 * validación de la URL (body {}) responde 200 sin pedir firma.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function safeEqHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verifica X-Kushki-Signature per la doc:
 *   HMAC-SHA256(secret, JSON.stringify(body) + "." + X-Kushki-Id) → hex.
 * Probamos canonical = JSON.stringify(parsed) (lo que firma Kushki) y, por las
 * dudas, el raw, por diferencias de serialización.
 */
function verifyBillingSignature(
  raw: string,
  parsed: Json,
  headers: Headers,
): { ok: boolean; reason: string; computed?: string } {
  const secret = env.KUSHKI_BILLING_WEBHOOK_SECRET ?? env.KUSHKI_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: "no_secret" };
  const xId = headers.get("x-kushki-id");
  const provided = headers.get("x-kushki-signature");
  if (!xId || !provided) return { ok: false, reason: "missing_headers" };

  const canonicals: string[] = [];
  try {
    canonicals.push(JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
  canonicals.push(raw);

  for (const c of canonicals) {
    const computed = createHmac("sha256", secret)
      .update(`${c}.${xId}`)
      .digest("hex");
    if (safeEqHex(computed, provided)) return { ok: true, reason: "ok" };
  }
  const computed = createHmac("sha256", secret)
    .update(`${JSON.stringify(parsed)}.${xId}`)
    .digest("hex");
  return { ok: false, reason: "mismatch", computed };
}

/** Resultado del evento, derivado del campo `name` del webhook. */
function outcomeFromName(
  name: string,
): "approved" | "declined" | "canceled" | "ignore" {
  const n = name.toLowerCase();
  if (n.includes("succes") && n.includes("charge")) return "approved";
  if (n.includes("declin") || n.includes("retry") || n.includes("fail"))
    return "declined";
  if (n.includes("delete")) return "canceled";
  return "ignore"; // subscriptionApproved (inicial, ya lo maneja activate) / desconocido
}

export async function POST(req: Request) {
  const raw = await req.text();

  const headerDump: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headerDump[k] = v;
  });
  console.log("[billing/webhook] headers", JSON.stringify(headerDump));
  console.log("[billing/webhook] body", raw.slice(0, 1500) || "(empty)");

  let payload: Json = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  // Shape real: { name, event: {...} }. Subscription id viene en `event`
  // (es un número). Toleramos también un shape plano (para simulaciones).
  const ev = payload && typeof payload.event === "object" ? payload.event : null;
  const subRaw =
    ev?.subscriptionId ?? payload?.subscriptionId ?? payload?.subscription_id;
  const subscriptionId =
    subRaw != null && subRaw !== "" ? String(subRaw) : undefined;
  const providerRef =
    (ev?.ticketNumber ??
      ev?.transactionReference ??
      payload?.ticketNumber ??
      payload?.transactionReference ??
      null) as string | null;
  const name: string =
    typeof payload?.name === "string"
      ? payload.name
      : typeof payload?.status === "string"
        ? payload.status // fallback simulación (status APPROVAL/DECLINED)
        : "";

  if (!subscriptionId) {
    // Validación de URL / handshake de Kushki (body {}): responder 200.
    console.log("[billing/webhook] handshake / validación de URL — 200");
    return NextResponse.json({ ok: true });
  }

  // Firma. Con secret configurado es obligatoria; sin secret, bypass (pruebas).
  const sig = verifyBillingSignature(raw, payload, req.headers);
  if (sig.reason === "no_secret") {
    console.warn(
      "[billing/webhook] sin KUSHKI_BILLING_WEBHOOK_SECRET — procesando sin verificar firma. Setealo en el VPS para producción.",
    );
  } else if (!sig.ok) {
    console.warn("[billing/webhook] firma inválida", {
      reason: sig.reason,
      computed: sig.computed,
      received: req.headers.get("x-kushki-signature"),
    });
    return NextResponse.json(
      { error: "invalid_signature", reason: sig.reason },
      { status: 401 },
    );
  } else {
    console.log("[billing/webhook] firma verificada ✓");
  }

  // Toleramos el shape plano de simulación (status/approved) cuando no hay name.
  let outcome = outcomeFromName(name);
  if (outcome === "ignore" && !payload?.name) {
    const s = (payload?.status ?? "").toString().toUpperCase();
    const approvedFlag = String(payload?.approved ?? "");
    if (s.includes("APPROV") || approvedFlag === "true") outcome = "approved";
    else if (s.includes("DECLIN") || approvedFlag === "false")
      outcome = "declined";
  }

  console.log("[billing/webhook] evento", {
    name,
    subscriptionId,
    providerRef,
    outcome,
  });

  if (outcome === "ignore") {
    return NextResponse.json({ ok: true, ignored: name || "unknown_event" });
  }

  // Resolver la suscripción.
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
    console.warn("[billing/webhook] suscripción no encontrada", {
      subscriptionId,
    });
    return NextResponse.json({ ok: true, ignored: "unknown_subscription" });
  }

  try {
    if (outcome === "canceled") {
      // Kushki canceló la suscripción (p.ej. tras agotar reintentos).
      await db.billingSubscription.update({
        where: { restaurantId: sub.restaurantId },
        data: { status: "canceled", canceledAt: new Date() },
      });
      await recordAuditEvent({
        kind: "subscription.cancel",
        restaurantId: sub.restaurantId,
        target: { type: "restaurant", id: sub.restaurantId },
        summary: `Kushki canceló el débito automático de ${sub.restaurant.name}`,
      });
      return NextResponse.json({ ok: true, status: "canceled" });
    }

    if (outcome === "approved") {
      // Idempotencia por ticket: no cobrar dos veces el mismo.
      if (providerRef) {
        const dup = await db.membershipPayment.findFirst({
          where: { restaurantId: sub.restaurantId, providerRef },
          select: { id: true },
        });
        if (dup) {
          return NextResponse.json({ ok: true, status: "already_processed" });
        }
      }
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

    // Declinado / reintento fallido. NO avanza el período → el cron de
    // vencimiento suspende cuando vence.
    await markRecurringChargeFailed(sub.restaurantId);
    await recordAuditEvent({
      kind: "subscription.charge.failed",
      restaurantId: sub.restaurantId,
      target: { type: "restaurant", id: sub.restaurantId },
      summary: `Cobro recurrente fallido de ${sub.restaurant.name} (${name})`,
    });
    return NextResponse.json({ ok: true, status: "declined" });
  } catch (err) {
    console.error("[billing/webhook] processing error", err);
    return NextResponse.json({ error: "processing_error" }, { status: 500 });
  }
}
