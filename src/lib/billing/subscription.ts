import { db } from "@/lib/db";
import { getPlanByTier } from "@/lib/planCatalog";
import type { Plan } from "@prisma/client";

/**
 * Suma `months` meses a una fecha y devuelve un ISO date (YYYY-MM-DD) en UTC.
 * Clampa el día si el mes destino es más corto (ej. 31 ene + 1 mes = 28/29 feb).
 */
export function addMonthsIso(from: Date, months: number): string {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Diferencia prorrateada a cobrar AHORA en un upgrade.
 *   prorated = round((newMonthly - oldMonthly) * daysLeft / daysInPeriod)
 * Devuelve 0 si no es upgrade (newMonthly <= oldMonthly) o si daysLeft <= 0.
 */
export function prorationCents(args: {
  oldMonthlyCents: number;
  newMonthlyCents: number;
  daysLeft: number;
  daysInPeriod: number;
}): number {
  const { oldMonthlyCents, newMonthlyCents, daysLeft, daysInPeriod } = args;
  if (newMonthlyCents <= oldMonthlyCents) return 0;
  if (daysLeft <= 0 || daysInPeriod <= 0) return 0;
  const clampedDays = Math.min(daysLeft, daysInPeriod);
  return Math.round(((newMonthlyCents - oldMonthlyCents) * clampedDays) / daysInPeriod);
}

/** Días enteros entre dos fechas (b - a), mínimo 0. */
export function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000));
}

/**
 * Resuelve el precio mensual en centavos del plan dado, usando el
 * precio del PlanConfig en DB (con fallback a defaultPriceCents del catálogo).
 * Si el restaurante ya tiene monthlyPriceCents no-cero, lo usa directamente.
 */
export async function resolvePlanPrice(args: {
  restaurantMonthlyPriceCents: number;
  tier: Plan;
}): Promise<number> {
  if (args.restaurantMonthlyPriceCents > 0) return args.restaurantMonthlyPriceCents;
  const entry = await getPlanByTier(args.tier);
  return entry.defaultPriceCents;
}

export type ApplyInitialChargeArgs = {
  restaurantId: string;
  plan: Plan;
  amountCents: number;
  currency: "COP" | "MXN";
  subscriptionId: string;
  transactionId: string | null;
  card: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  };
  startDateIso: string; // ISO date YYYY-MM-DD — cuándo empieza a cobrar Kushki
  periodEndsAt: Date;   // cuando vence el período que acabamos de pagar
  actorEmail: string;   // para MembershipPayment.recordedByEmail
};

/**
 * Persiste el resultado de un cobro de activación (kind="initial"):
 *   1. Crea MembershipPayment(kind="initial", method="kushki_card")
 *   2. Actualiza Restaurant(plan, monthlyPriceCents, periodEndsAt, suspended=false)
 *   3. Upserta BillingSubscription(status=active, nextChargeAt=startDate, card meta)
 * Todo en una transacción.
 */
export async function applyInitialCharge(args: ApplyInitialChargeArgs): Promise<void> {
  await db.$transaction(async (tx) => {
    // 1. Registrar el pago
    await tx.membershipPayment.create({
      data: {
        restaurantId: args.restaurantId,
        amountCents: args.amountCents,
        method: "kushki_card",
        kind: "initial",
        providerRef: args.transactionId,
        recordedByEmail: args.actorEmail,
        periodStart: new Date(),
        periodEnd: args.periodEndsAt,
      },
    });

    // 2. Avanzar el plan del restaurante
    await tx.restaurant.update({
      where: { id: args.restaurantId },
      data: {
        plan: args.plan,
        monthlyPriceCents: args.amountCents,
        periodEndsAt: args.periodEndsAt,
        suspended: false,
      },
    });

    // 3. Upsert BillingSubscription
    await tx.billingSubscription.upsert({
      where: { restaurantId: args.restaurantId },
      create: {
        restaurantId: args.restaurantId,
        provider: "kushki",
        kushkiSubscriptionId: args.subscriptionId,
        plan: args.plan,
        amountCents: args.amountCents,
        currency: args.currency,
        status: "active",
        cardBrand: args.card.brand,
        cardLast4: args.card.last4,
        cardExpMonth: args.card.expMonth,
        cardExpYear: args.card.expYear,
        nextChargeAt: new Date(args.startDateIso),
      },
      update: {
        kushkiSubscriptionId: args.subscriptionId,
        plan: args.plan,
        amountCents: args.amountCents,
        currency: args.currency,
        status: "active",
        cardBrand: args.card.brand,
        cardLast4: args.card.last4,
        cardExpMonth: args.card.expMonth,
        cardExpYear: args.card.expYear,
        nextChargeAt: new Date(args.startDateIso),
        canceledAt: null,
      },
    });
  });
}

/**
 * Persiste un COBRO RECURRENTE aprobado (kind="recurring"), notificado por el
 * webhook de Kushki. Avanza el período del comercio un mes y reactiva la
 * suscripción. Idempotencia: el caller debe deduplicar por providerRef antes
 * de llamar (no cobramos dos veces el mismo ticket).
 *   1. MembershipPayment(kind="recurring", method="kushki_card")
 *   2. Restaurant.periodEndsAt = nuevo fin de período, suspended=false
 *   3. BillingSubscription: status="active", failedAttempts=0, period/nextCharge
 */
export async function applyRecurringCharge(args: {
  restaurantId: string;
  amountCents: number;
  currency: string;
  providerRef: string | null;
  periodStart: Date;
  periodEnd: Date;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.membershipPayment.create({
      data: {
        restaurantId: args.restaurantId,
        amountCents: args.amountCents,
        method: "kushki_card",
        kind: "recurring",
        providerRef: args.providerRef,
        recordedByEmail: "kushki-webhook",
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
      },
    });
    await tx.restaurant.update({
      where: { id: args.restaurantId },
      data: { periodEndsAt: args.periodEnd, suspended: false },
    });
    await tx.billingSubscription.update({
      where: { restaurantId: args.restaurantId },
      data: {
        status: "active",
        failedAttempts: 0,
        currentPeriodEnd: args.periodEnd,
        nextChargeAt: args.periodEnd,
      },
    });
  });
}

/**
 * Marca un cobro recurrente FALLIDO. NO avanza el período: deja que el cron de
 * vencimiento existente suspenda el comercio cuando `periodEndsAt` venza. Solo
 * actualiza el estado de la suscripción para visibilidad/dunning.
 */
export async function markRecurringChargeFailed(
  restaurantId: string,
): Promise<void> {
  await db.billingSubscription.update({
    where: { restaurantId },
    data: { status: "past_due", failedAttempts: { increment: 1 } },
  });
}

/**
 * Persiste activación sin cobro inmediato (startDate futuro = periodEndsAt).
 * Solo crea/actualiza BillingSubscription; no crea MembershipPayment ni
 * toca el Restaurant (el período ya está vigente).
 */
export async function applySubscriptionWithoutCharge(args: {
  restaurantId: string;
  plan: Plan;
  amountCents: number;
  currency: "COP" | "MXN";
  subscriptionId: string;
  card: ApplyInitialChargeArgs["card"];
  nextChargeAt: Date;
}): Promise<void> {
  await db.billingSubscription.upsert({
    where: { restaurantId: args.restaurantId },
    create: {
      restaurantId: args.restaurantId,
      provider: "kushki",
      kushkiSubscriptionId: args.subscriptionId,
      plan: args.plan,
      amountCents: args.amountCents,
      currency: args.currency,
      status: "active",
      cardBrand: args.card.brand,
      cardLast4: args.card.last4,
      cardExpMonth: args.card.expMonth,
      cardExpYear: args.card.expYear,
      nextChargeAt: args.nextChargeAt,
    },
    update: {
      kushkiSubscriptionId: args.subscriptionId,
      plan: args.plan,
      amountCents: args.amountCents,
      currency: args.currency,
      status: "active",
      cardBrand: args.card.brand,
      cardLast4: args.card.last4,
      cardExpMonth: args.card.expMonth,
      cardExpYear: args.card.expYear,
      nextChargeAt: args.nextChargeAt,
      canceledAt: null,
    },
  });
}
