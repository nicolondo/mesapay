import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getSubscriptionProvider } from "@/lib/payments/subscription";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import {
  currencyForCountry,
  addMonthsIso,
  resolvePlanPrice,
  applyInitialCharge,
  applySubscriptionWithoutCharge,
} from "@/lib/billing/subscription";
import { recordAuditEvent } from "@/lib/auditLog";
import type { Plan } from "@prisma/client";

function guard(role?: string | null) {
  return role === "operator" || role === "platform_admin";
}

const bodySchema = z.object({
  token: z.string().min(1),
  planTier: z.enum(["trial", "basic", "pro"]),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }
  const { token, planTier } = parsed.data;

  // Cargar el restaurante para saber estado actual y país
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      plan: true,
      monthlyPriceCents: true,
      periodEndsAt: true,
      country: true,
      kushkiMode: true,
    },
  });
  if (!tenant) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 404 });
  }

  // Fix 1: idempotency guard — no double-charge if subscription already active
  const existing = await db.billingSubscription.findUnique({ where: { restaurantId } });
  if (existing && existing.status === "active" && existing.kushkiSubscriptionId) {
    return NextResponse.json({ error: "already_active" }, { status: 409 });
  }

  const currency = currencyForCountry(tenant.country);
  const amountCents = await resolvePlanPrice({
    restaurantMonthlyPriceCents: tenant.monthlyPriceCents,
    tier: planTier as Plan,
  });

  // Fix 2: reject price-0 / trial activation
  if (amountCents <= 0) {
    return NextResponse.json({ error: "invalid_plan_price" }, { status: 422 });
  }

  // Regla de fecha: si hay período vigente → sin cobro inmediato; si no → cobrar ahora
  const now = new Date();
  const periodEndsAt = tenant.periodEndsAt;
  const hasFuturePeriod = periodEndsAt != null && periodEndsAt > now;

  // startDate para Kushki: debe ser FUTURO (no el mismo día según regla Kushki)
  let startDateIso: string;
  let doImmediateCharge: boolean;

  if (hasFuturePeriod) {
    // El restaurante ya tiene período vigente → primera renovación = cuando vence
    startDateIso = periodEndsAt!.toISOString().slice(0, 10);
    doImmediateCharge = false;
  } else {
    // Sin período vigente → cobrar ahora + agendar desde hoy+1mes
    startDateIso = addMonthsIso(now, 1);
    doImmediateCharge = true;
  }

  const mode = await getRestaurantKushkiMode(tenant);
  const provider = await getSubscriptionProvider(mode);

  const actorEmail = session!.user!.email ?? "billing@mesapay.co";

  // Datos de contacto mínimos (Kushki los requiere)
  const contactDetails = {
    firstName: session!.user!.name?.split(" ")[0] ?? "Operador",
    lastName: session!.user!.name?.split(" ").slice(1).join(" ") ?? "MESAPAY",
    email: actorEmail,
  };

  console.log("[billing] activate: creating subscription", {
    restaurantId,
    planTier,
    amountCents,
    currency,
    startDateIso,
    doImmediateCharge,
    mode,
  });

  // 1. Crear la suscripción en Kushki
  let createResult: Awaited<ReturnType<typeof provider.createCardSubscription>>;
  try {
    createResult = await provider.createCardSubscription({
      token,
      planName: planTier,
      amountCents,
      currency,
      startDateIso,
      contactDetails,
      metadata: { restaurantId, platform: "mesapay" },
    });
  } catch (err) {
    console.error("[billing] activate: createCardSubscription failed", err);
    // En sandbox/mock exponemos el detalle para depurar contra Kushki; en
    // producción NO (evita filtrar internals).
    return NextResponse.json(
      {
        error: "create_failed",
        detail: mode !== "production" ? String(err) : undefined,
      },
      { status: 502 },
    );
  }

  const { subscriptionId, card } = createResult;
  console.log("[billing] activate: subscription created", {
    subscriptionId,
    cardLast4: card.last4,
    cardBrand: card.brand,
  });

  // 2. Cobro inmediato si aplica
  if (doImmediateCharge) {
    let chargeResult: Awaited<ReturnType<typeof provider.chargeSubscriptionNow>>;
    try {
      chargeResult = await provider.chargeSubscriptionNow({
        subscriptionId,
        amountCents,
        currency,
        metadata: { restaurantId, kind: "initial" },
      });
    } catch (err) {
      // Intentar cancelar la suscripción para no dejar huérfana
      try {
        await provider.cancelSubscription({ subscriptionId });
      } catch (cancelErr) {
        console.error("[billing] activate: failed to cancel orphan subscription", cancelErr);
      }
      console.error("[billing] activate: chargeSubscriptionNow threw", err);
      return NextResponse.json(
        {
          error: "charge_failed",
          detail: mode !== "production" ? String(err) : undefined,
        },
        { status: 502 },
      );
    }

    console.log("[billing] activate: charge result", {
      status: chargeResult.status,
      transactionId: chargeResult.transactionId,
    });

    if (chargeResult.status === "declined") {
      // Cancelar la suscripción para no dejar huérfana
      try {
        await provider.cancelSubscription({ subscriptionId });
      } catch (cancelErr) {
        console.error("[billing] activate: failed to cancel after declined charge", cancelErr);
      }
      return NextResponse.json(
        { error: "charge_declined", message: chargeResult.message ?? "Tarjeta rechazada" },
        { status: 402 },
      );
    }

    // Cobro aprobado → persistir
    const newPeriodEndsAt = new Date(addMonthsIso(now, 1));
    await applyInitialCharge({
      restaurantId,
      plan: planTier as Plan,
      amountCents,
      currency,
      subscriptionId,
      transactionId: chargeResult.transactionId,
      card,
      startDateIso,
      periodEndsAt: newPeriodEndsAt,
      actorEmail,
    });
  } else {
    // Sin cobro inmediato → solo persistir la suscripción
    await applySubscriptionWithoutCharge({
      restaurantId,
      plan: planTier as Plan,
      amountCents,
      currency,
      subscriptionId,
      card,
      nextChargeAt: new Date(startDateIso),
    });
  }

  await recordAuditEvent({
    kind: "subscription.activate",
    restaurantId,
    target: { type: "billing_subscription", id: subscriptionId },
    summary: `Activó débito automático plan=${planTier} monto=${amountCents} currency=${currency} startDate=${startDateIso} immediateCharge=${doImmediateCharge}`,
  });

  return NextResponse.json({ ok: true, subscriptionId, cardLast4: card.last4 });
}
