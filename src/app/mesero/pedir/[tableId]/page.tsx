import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { normalizeModifiers } from "@/lib/modifiers";
import { ensureDefaultMenu } from "@/lib/menus";
import { getRestaurantMenuTags } from "@/lib/menuTags";
import { MenuClient } from "@/app/t/[slug]/menu/MenuClient";

export const dynamic = "force-dynamic";

/**
 * "Tomar pedido" inline para el mesero — vive bajo /mesero/ para
 * mantenerse dentro del scope del PWA instalado. Hace exactamente
 * lo que /t/[slug]/menu?table=TOKEN&op=1 pero sin sacar al usuario
 * de la app: el PWA scope `/mesero/` bloquea navegación hacia
 * /t/* (los abriría en Safari aparte).
 *
 * Resolvemos la mesa por ID (no qrToken) porque el botón viene de
 * /mesero/mesas que ya tiene el id a mano. Si el mesero no tiene
 * acceso a esa mesa (asignaciones), devolvemos 404 — para no leakear
 * existencia.
 */
export default async function MeseroPedirPage({
  params,
}: {
  params: Promise<{ tableId: string }>;
}) {
  const { tableId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/mesero/mesas");
  // Solo staff con razón para usar este flujo. Otros roles caen al
  // home estándar; el cliente ya tiene su propio /t/[slug]/menu.
  const role = session.user.role;
  if (role !== "mesero" && role !== "operator" && role !== "platform_admin") {
    redirect("/");
  }

  const table = await db.table.findUnique({
    where: { id: tableId },
    include: { restaurant: true },
  });
  if (!table) return notFound();
  const tenant = table.restaurant;

  // Tenant scope check — un mesero de otro restaurante no debe ver
  // estas mesas. Para operator/admin con impersonación, la sesión
  // ya marca su restaurantId; no expandimos el scope acá.
  if (
    role === "mesero" &&
    session.user.restaurantId &&
    session.user.restaurantId !== tenant.id
  ) {
    return notFound();
  }

  // Scope mesa por mesa cuando el mesero tiene un rango asignado.
  // assignedTableNumbers vacío = atiende todas. Operator/admin
  // ignoran este filtro.
  if (role === "mesero") {
    const me = await db.user.findUnique({
      where: { id: session.user.id },
      select: { assignedTableNumbers: true },
    });
    const nums = me?.assignedTableNumbers ?? [];
    if (nums.length > 0 && !nums.includes(table.number)) {
      return notFound();
    }
  }

  await ensureDefaultMenu(tenant.id);
  const [menus, menuTags, ratingAgg, categories, items, activeOrder] =
    await Promise.all([
      db.menu.findMany({
        where: { restaurantId: tenant.id },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, slug: true, label: true, description: true },
      }),
      getRestaurantMenuTags(tenant.id),
      db.dishRating.groupBy({
        by: ["menuItemId"],
        where: { restaurantId: tenant.id },
        _avg: { stars: true },
        _count: { stars: true },
      }),
      db.category.findMany({
        where: { restaurantId: tenant.id },
        orderBy: { sortOrder: "asc" },
      }),
      db.menuItem.findMany({
        where: { restaurantId: tenant.id, available: true },
        orderBy: { sortOrder: "asc" },
      }),
      db.order.findFirst({
        where: {
          tableId: table.id,
          restaurantId: tenant.id,
          status: { notIn: ["paid", "cancelled"] },
        },
        orderBy: { createdAt: "desc" },
        include: {
          rounds: { orderBy: { seq: "asc" } },
          items: { orderBy: { id: "asc" } },
        },
      }),
    ]);

  const ratingByItem = new Map(
    ratingAgg.map((r) => [
      r.menuItemId,
      { avg: r._avg.stars ?? 0, count: r._count.stars },
    ]),
  );

  return (
    <MenuClient
      operatorMode
      // Después de enviar el round volvemos a Salón del mesero
      // (donde aterriza el push "listo para entregar" más tarde).
      postSendHref="/mesero/salon"
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
          : table.label
            ? `Mesa ${table.number} · ${table.label}`
            : `Mesa ${table.number}`
      }
      menus={menus}
      menuTags={menuTags}
      categories={categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        label: c.label,
        menuId: c.menuId ?? menus[0]?.id ?? "",
      }))}
      items={items.map((m) => {
        const r = ratingByItem.get(m.id);
        return {
          id: m.id,
          categoryId: m.categoryId,
          name: m.name,
          description: m.description ?? "",
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
