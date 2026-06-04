import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { TranslationsClient } from "./TranslationsClient";

export const dynamic = "force-dynamic";

export default async function TraduccionesPage() {
  const t = await getTranslations("opTranslations");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const [cats, items] = await Promise.all([
    db.category.findMany({
      where: { restaurantId },
      orderBy: { sortOrder: "asc" },
      select: { id: true, label: true },
    }),
    db.menuItem.findMany({
      where: { restaurantId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, description: true, categoryId: true },
    }),
  ]);

  const ids = [...cats.map((c) => c.id), ...items.map((i) => i.id)];
  const trans = ids.length
    ? await db.translation.findMany({
        where: {
          locale: { in: ["en", "pt"] },
          entityType: { in: ["MenuItem", "Category"] },
          entityId: { in: ids },
        },
        select: {
          entityType: true,
          entityId: true,
          field: true,
          locale: true,
          value: true,
        },
      })
    : [];
  const tmap = new Map<string, string>();
  for (const tr of trans) {
    tmap.set(`${tr.entityType}:${tr.entityId}:${tr.field}:${tr.locale}`, tr.value);
  }
  const tv = (et: string, id: string, f: string, loc: string) =>
    tmap.get(`${et}:${id}:${f}:${loc}`) ?? "";

  const byCat = (catId: string) =>
    items
      .filter((i) => i.categoryId === catId)
      .map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description,
        nameEn: tv("MenuItem", i.id, "name", "en"),
        namePt: tv("MenuItem", i.id, "name", "pt"),
        descEn: i.description ? tv("MenuItem", i.id, "description", "en") : "",
        descPt: i.description ? tv("MenuItem", i.id, "description", "pt") : "",
      }));

  const knownCatIds = new Set(cats.map((c) => c.id));
  const groups = cats.map((c) => ({
    categoryId: c.id,
    categoryLabel: c.label,
    categoryEn: tv("Category", c.id, "label", "en"),
    categoryPt: tv("Category", c.id, "label", "pt"),
    items: byCat(c.id),
  }));
  // Platos sin categoría conocida (defensivo) → grupo "otros".
  const orphan = items
    .filter((i) => !knownCatIds.has(i.categoryId))
    .map((i) => ({
      id: i.id,
      name: i.name,
      description: i.description,
      nameEn: tv("MenuItem", i.id, "name", "en"),
      namePt: tv("MenuItem", i.id, "name", "pt"),
      descEn: i.description ? tv("MenuItem", i.id, "description", "en") : "",
      descPt: i.description ? tv("MenuItem", i.id, "description", "pt") : "",
    }));
  if (orphan.length) {
    groups.push({
      categoryId: "__orphan__",
      categoryLabel: t("uncategorized"),
      categoryEn: "",
      categoryPt: "",
      items: orphan,
    });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {t("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("subtitle")}</p>
      <TranslationsClient groups={groups} itemCount={items.length} />
    </div>
  );
}
