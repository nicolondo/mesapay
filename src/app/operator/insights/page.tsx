import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveAiEnabled } from "@/lib/ai/aiAccess";
import { InsightsChat } from "./InsightsChat";

export const dynamic = "force-dynamic";

export default async function InsightsPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) redirect("/operator");
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { plan: true, aiInsightsEnabled: true },
  });
  const t = await getTranslations("insights");
  if (!r || !resolveAiEnabled(r)) {
    return <div className="p-6 max-w-2xl mx-auto text-op-muted">{t("disabled")}</div>;
  }
  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto w-full">
      <h1 className="font-display text-3xl mb-1">{t("title")}</h1>
      <p className="text-op-muted text-sm mb-4">{t("subtitle")}</p>
      <InsightsChat />
    </div>
  );
}
