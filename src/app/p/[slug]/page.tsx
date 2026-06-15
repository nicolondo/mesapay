import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import {
  formatNextOpening,
  pickupStatus,
} from "@/lib/pickupAvailability";
import { normalizeModifiers } from "@/lib/modifiers";
import { getRestaurantMenuTags } from "@/lib/menuTags";
import { getContentTranslations } from "@/lib/translateContent";
import { defaultLocale, type Locale } from "@/i18n/config";
import { MenuClient } from "../../t/[slug]/menu/MenuClient";

export const dynamic = "force-dynamic";

export default async function PickupPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const { slug } = await params;
  const { t: tableToken } = await searchParams;

  const tenant = await db.restaurant.findUnique({
    where: { slug },
    include: {
      categories: { orderBy: { sortOrder: "asc" } },
      menuItems: {
        where: { available: true },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!tenant) return notFound();

  const t = await getTranslations("pickup");

  if (!tenant.pickupEnabled) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-20 bg-bone">
        <div className="text-center max-w-sm">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted mb-3">
            {tenant.name}
          </div>
          <h1 className="font-display text-3xl mb-3">{t("unavailableTitle")}</h1>
          <p className="text-muted">{t("unavailableBody")}</p>
        </div>
      </main>
    );
  }

  const pickupTable = await db.table.findFirst({
    where: { restaurantId: tenant.id, number: -1 },
  });
  if (!pickupTable) return notFound();

  // Token check: if provided, must match the pickup table so stray scans fail
  // cleanly. If omitted, we still allow browsing (link sharing).
  if (tableToken && tableToken !== pickupTable.qrToken) {
    return notFound();
  }

  const status = pickupStatus(tenant.pickupHours);
  if (!status.open) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-20 bg-bone">
        <div className="text-center max-w-sm">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-terracotta mb-3">
            {tenant.name}
          </div>
          <h1 className="font-display text-3xl mb-3">{t("closedTitle")}</h1>
          <p className="text-muted">
            {status.nextOpenAt
              ? t("reopenAt", { when: formatNextOpening(status.nextOpenAt) })
              : t("noNextOpening")}
          </p>
        </div>
      </main>
    );
  }

  // Same rating aggregation used on the table menu — pickup gets the full
  // rich browsing UI, including star averages per dish.
  const ratingAgg = await db.dishRating.groupBy({
    by: ["menuItemId"],
    where: { restaurantId: tenant.id },
    _avg: { stars: true },
    _count: { stars: true },
  });
  const ratingByItem = new Map(
    ratingAgg.map((r) => [
      r.menuItemId,
      { avg: r._avg.stars ?? 0, count: r._count.stars },
    ]),
  );

  const menuTags = await getRestaurantMenuTags(tenant.id);

  const session = await auth();
  const customer = session?.user?.id
    ? await db.user.findUnique({
        where: { id: session.user.id },
        select: { name: true, phone: true },
      })
    : null;

  // i18n — traducción del CONTENIDO del menú (igual que la carta de mesa).
  const locale = await getLocale();
  let contentT = new Map<string, string>();
  if (locale !== defaultLocale) {
    const toTranslate: {
      entityType: string;
      entityId: string;
      field: string;
      text: string;
    }[] = [];
    for (const c of tenant.categories) {
      if (c.label)
        toTranslate.push({ entityType: "Category", entityId: c.id, field: "label", text: c.label });
    }
    for (const it of tenant.menuItems) {
      if (it.name)
        toTranslate.push({ entityType: "MenuItem", entityId: it.id, field: "name", text: it.name });
      if (it.description)
        toTranslate.push({ entityType: "MenuItem", entityId: it.id, field: "description", text: it.description });
    }
    for (const tag of menuTags) {
      if (tag.label)
        toTranslate.push({ entityType: "MenuTag", entityId: tag.slug, field: "label", text: tag.label });
    }
    contentT = await getContentTranslations(locale as Locale, toTranslate);
  }
  const tr = (
    entityType: string,
    entityId: string,
    field: string,
    fallback: string,
  ) => contentT.get(`${entityType}:${entityId}:${field}`) ?? fallback;
  const localizedMenuTags = menuTags.map((tag) => ({
    ...tag,
    label: tr("MenuTag", tag.slug, "label", tag.label),
  }));

  return (
    <MenuClient
      tenant={{
        slug: tenant.slug,
        name: tenant.name,
        tagline: tenant.tagline,
        serviceMode: tenant.serviceMode,
      }}
      tableId={pickupTable.id}
      locationLabel={t("locationLabel")}
      menuTags={localizedMenuTags}
      categories={tenant.categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        label: tr("Category", c.id, "label", c.label),
        // Pickup doesn't surface menu tabs (it's already a focused
        // single-flow experience), but the type requires the field.
        menuId: c.menuId ?? "",
        parentId: c.parentId ?? null,
      }))}
      items={tenant.menuItems.map((m) => {
        const r = ratingByItem.get(m.id);
        return {
          id: m.id,
          categoryId: m.categoryId,
          name: tr("MenuItem", m.id, "name", m.name),
          description: m.description
            ? tr("MenuItem", m.id, "description", m.description)
            : "",
          priceCents: m.priceCents,
          tags: m.tags,
          photoUrl: m.photoUrl ?? null,
          modifiers: (() => {
            const norm = normalizeModifiers(m.modifiers);
            return norm.length > 0 ? norm : null;
          })(),
          ratingAvg: r?.avg ?? 0,
          ratingCount: r?.count ?? 0,
        };
      })}
      activeOrder={null}
      pickup={{
        defaultName: customer?.name ?? "",
        defaultPhone: customer?.phone ?? "",
        maxEtaMinutes: tenant.pickupMaxEtaMinutes,
        kushkiReady:
          !!tenant.kushkiMerchantId &&
          tenant.kushkiOnboardingStatus === "active",
        kushkiPublicKey: tenant.kushkiPublicKey,
        isMockMode: (await getRestaurantKushkiMode(tenant)) === "mock",
      }}
    />
  );
}
