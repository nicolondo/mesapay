import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getRestaurantMenuTags } from "@/lib/menuTags";
import { TagsClient } from "./TagsClient";

export const dynamic = "force-dynamic";

export default async function TagsSettingsPage() {
  const t = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const tags = await getRestaurantMenuTags(restaurantId);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {t("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("tagsTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("tagsIntro")}</p>

      <TagsClient initial={tags} />
    </div>
  );
}
