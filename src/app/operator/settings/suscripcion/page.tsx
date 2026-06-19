import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { SubscriptionClient } from "./SubscriptionClient";
import { env } from "@/lib/env";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  const t = await getTranslations("opSubscription");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      plan: true,
      monthlyPriceCents: true,
      periodEndsAt: true,
      suspended: true,
      country: true,
      kushkiMode: true,
      billingSubscription: true,
      membershipPayments: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!tenant) return <div className="p-6">{t("noRestaurant")}</div>;

  // Modo Kushki efectivo para este restaurante (respeta override por comercio)
  const kushkiMode = await getRestaurantKushkiMode(tenant);
  // Clave pública de plataforma (segura en browser) — null si no configurada
  const kushkiPublicKey = env.KUSHKI_BILLING_PUBLIC_KEY ?? null;

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="text-sm text-op-muted hover:underline"
      >
        {tSettings("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("subtitle")}</p>

      <SubscriptionClient
        plan={tenant.plan}
        monthlyPriceCents={tenant.monthlyPriceCents}
        periodEndsAtIso={tenant.periodEndsAt?.toISOString() ?? null}
        statusKey={
          tenant.suspended
            ? "suspended"
            : tenant.billingSubscription?.status === "canceled"
              ? "canceled"
              : tenant.periodEndsAt && tenant.periodEndsAt < new Date()
                ? "overdue"
                : "active"
        }
        country={tenant.country}
        subscription={
          tenant.billingSubscription
            ? {
                status: tenant.billingSubscription.status,
                cardBrand: tenant.billingSubscription.cardBrand,
                cardLast4: tenant.billingSubscription.cardLast4,
                cardExpMonth: tenant.billingSubscription.cardExpMonth,
                cardExpYear: tenant.billingSubscription.cardExpYear,
                nextChargeAtIso:
                  tenant.billingSubscription.nextChargeAt?.toISOString() ??
                  null,
              }
            : null
        }
        payments={tenant.membershipPayments.map((p) => ({
          id: p.id,
          createdAtIso: p.createdAt.toISOString(),
          periodStartIso: p.periodStart.toISOString(),
          periodEndIso: p.periodEnd.toISOString(),
          amountCents: p.amountCents,
          method: p.method,
          kind: p.kind,
        }))}
        kushkiPublicKey={kushkiPublicKey}
        kushkiMode={kushkiMode}
      />
    </div>
  );
}
