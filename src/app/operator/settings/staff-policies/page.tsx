import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  resolveTipPolicy,
  resolveShiftPolicy,
} from "@/lib/staffPolicies";
import { StaffPoliciesClient } from "./StaffPoliciesClient";

export const dynamic = "force-dynamic";

export default async function StaffPoliciesPage() {
  const t = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      tipPolicy: true,
      shiftPolicy: true,
      walkoutDangerMinutes: true,
      businessDayCutoffHour: true,
    },
  });
  if (!tenant) return <div className="p-6">{t("restaurantNotFound")}</div>;

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="text-sm text-op-muted hover:underline"
      >
        {t("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">
        {t("policiesTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">{t("policiesIntro")}</p>

      <StaffPoliciesClient
        initialTipPolicy={resolveTipPolicy(tenant.tipPolicy)}
        initialShiftPolicy={resolveShiftPolicy(tenant.shiftPolicy)}
        initialWalkoutDangerMinutes={tenant.walkoutDangerMinutes ?? 20}
        initialBusinessDayCutoffHour={tenant.businessDayCutoffHour ?? 5}
      />
    </div>
  );
}
