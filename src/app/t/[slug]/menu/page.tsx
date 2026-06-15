import { db } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { normalizeModifiers } from "@/lib/modifiers";
import { ensureDefaultMenu } from "@/lib/menus";
import { getRestaurantMenuTags } from "@/lib/menuTags";
import { getContentTranslations } from "@/lib/translateContent";
import { defaultLocale, type Locale } from "@/i18n/config";
import { MenuClient } from "./MenuClient";

export default async function MenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ table?: string; order?: string; op?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const tableToken = sp.table;
  if (!tableToken) redirect(`/t/${slug}`);

  // Waiter mode: el staff (operator/admin/mesero) abrió esta página
  // para tomar pedido por un comensal que no tiene celular. Solo
  // honramos ?op=1 cuando la sesión es staff real — nunca confiamos
  // en el query param solo. Cuando está activo: skip del sheet
  // "Yo soy …", copy de mesero, y al enviar redirige al home del
  // staff (Salón).
  const session = sp.op === "1" ? await auth() : null;
  const isStaff =
    !!session?.user &&
    (session.user.role === "operator" ||
      session.user.role === "platform_admin" ||
      session.user.role === "mesero");
  const operatorMode = isStaff;
  // Donde aterriza el staff después de enviar el round. Mesero no
  // tiene acceso a /operator/* (layout gated) → /mesero/salon.
  const postSendHref =
    session?.user?.role === "mesero" ? "/mesero/salon" : "/operator/serve";

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

  // Make sure the restaurant has at least one menu and that every
  // category points at one. ensureDefaultMenu is idempotent — on
  // first-ever read it creates the Carta and backfills null menuIds.
  await ensureDefaultMenu(tenant.id);
  const [menus, menuTags] = await Promise.all([
    db.menu.findMany({
      where: { restaurantId: tenant.id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, slug: true, label: true, description: true },
    }),
    getRestaurantMenuTags(tenant.id),
  ]);

  // Aggregate ratings per menu item so each card can show a star average.
  // Customers never see the comments here — just the numbers.
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

  const table = await db.table.findUnique({ where: { qrToken: tableToken } });
  if (!table || table.restaurantId !== tenant.id) {
    return notFound();
  }

  // Find active (non-paid) order for this table. If ?order= is given, prefer it.
  // Otherwise pick the most recent open order on this table — so anyone scanning
  // the QR sees the current shared bill. In counter mode we skip the shared
  // resume: each scan starts a fresh order unless ?order= is explicit.
  const activeOrder =
    tenant.serviceMode === "counter" && !sp.order
      ? null
      : await db.order.findFirst({
          where: {
            tableId: table.id,
            restaurantId: tenant.id,
            status: { notIn: ["paid", "cancelled"] },
            ...(sp.order ? { id: sp.order } : {}),
          },
          orderBy: { createdAt: "desc" },
          include: {
            rounds: { orderBy: { seq: "asc" } },
            items: { where: { cancelledAt: null }, orderBy: { id: "asc" } },
          },
        });

  // i18n — traducción del CONTENIDO del menú (nombres/descripciones de
  // platos, categorías, menús) al idioma del comensal. Server-side y
  // cacheado en la tabla Translation (ver lib/translateContent). En "es"
  // (default) es no-op; sin ANTHROPIC_API_KEY cae al texto original.
  const locale = await getLocale();
  const tMenu = await getTranslations("menu");
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
    for (const m of menus) {
      if (m.label)
        toTranslate.push({ entityType: "Menu", entityId: m.id, field: "label", text: m.label });
      if (m.description)
        toTranslate.push({ entityType: "Menu", entityId: m.id, field: "description", text: m.description });
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
    // request.ts garantiza un locale válido; getLocale() lo tipa como string.
    contentT = await getContentTranslations(locale as Locale, toTranslate);
  }
  const tr = (
    entityType: string,
    entityId: string,
    field: string,
    fallback: string,
  ) => contentT.get(`${entityType}:${entityId}:${field}`) ?? fallback;

  const localizedMenus = menus.map((m) => ({
    ...m,
    label: tr("Menu", m.id, "label", m.label),
    description: m.description
      ? tr("Menu", m.id, "description", m.description)
      : m.description,
  }));

  const localizedMenuTags = menuTags.map((tag) => ({
    ...tag,
    label: tr("MenuTag", tag.slug, "label", tag.label),
  }));

  return (
    <MenuClient
      operatorMode={operatorMode}
      postSendHref={postSendHref}
      tenant={{
        slug: tenant.slug,
        name: tenant.name,
        tagline: tenant.tagline,
        serviceMode: tenant.serviceMode,
        logoUrl: tenant.logoUrl,
      }}
      tableId={table.id}
      tableQrToken={table.qrToken}
      // Llamada al mesero "ya pendiente" para hidratar el FAB:
      // (a) si hay orden activa con needsWaiter, o
      // (b) si la mesa misma tiene waiterCalledAt > waiterAckedAt.
      initialWaiterCalled={
        (activeOrder?.needsWaiter ?? false) ||
        (table.waiterCalledAt != null &&
          (!table.waiterAckedAt ||
            table.waiterAckedAt.getTime() <
              table.waiterCalledAt.getTime()))
      }
      locationLabel={
        tenant.serviceMode === "counter"
          ? tMenu("counter")
          : tMenu("tableLabel", { number: table.number })
      }
      menus={localizedMenus}
      menuTags={localizedMenuTags}
      categories={tenant.categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        label: tr("Category", c.id, "label", c.label),
        menuId: c.menuId ?? menus[0]?.id ?? "",
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
          // Normalise legacy string-only opts and drop malformed
          // entries so the diner sheet only deals with one shape.
          // Returning null when there are no usable modifiers keeps
          // the menu light — the renderer skips the section entirely.
          modifiers: (() => {
            const norm = normalizeModifiers(m.modifiers);
            return norm.length > 0 ? norm : null;
          })(),
          ratingAvg: r?.avg ?? 0,
          ratingCount: r?.count ?? 0,
        };
      })}
      activeOrder={
        activeOrder
          ? {
              id: activeOrder.id,
              shortCode: activeOrder.shortCode,
              subtotalCents: activeOrder.subtotalCents,
              status: activeOrder.status,
              itemCount: activeOrder.items.reduce((s, i) => s + i.qty, 0),
              roundCount: activeOrder.rounds.length,
              items: activeOrder.items.map((i) => ({
                id: i.id,
                name: i.nameSnapshot,
                qty: i.qty,
                priceCents: i.priceCentsSnapshot,
              })),
            }
          : null
      }
    />
  );
}

// ModifierDef + ModOpt are defined inside MenuClient.tsx; this page
// just passes the normalised array through.
