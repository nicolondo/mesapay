import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { SubscriptionClient } from "./SubscriptionClient";

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
      billingSubscription: true,
      membershipPayments: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!tenant) return <div className="p-6">{t("noRestaurant")}</div>;

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
        suspended={tenant.suspended}
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
      />
    </div>
  );
}
