import { db } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { normalizeModifiers } from "@/lib/modifiers";
import { ensureDefaultMenu } from "@/lib/menus";
import { getRestaurantMenuTags } from "@/lib/menuTags";
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
            items: { orderBy: { id: "asc" } },
          },
        });

  return (
    <MenuClient
      operatorMode={operatorMode}
      postSendHref={postSendHref}
      tenant={{
        slug: tenant.slug,
        name: tenant.name,
        tagline: tenant.tagline,
        serviceMode: tenant.serviceMode,
      }}
      tableId={table.id}
      locationLabel={
        tenant.serviceMode === "counter"
          ? "Mostrador"
          : `Mesa ${table.number}`
      }
      menus={menus}
      menuTags={menuTags}
      categories={tenant.categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        label: c.label,
        menuId: c.menuId ?? menus[0]?.id ?? "",
      }))}
      items={tenant.menuItems.map((m) => {
        const r = ratingByItem.get(m.id);
        return {
          id: m.id,
          categoryId: m.categoryId,
          name: m.name,
          description: m.description ?? "",
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
