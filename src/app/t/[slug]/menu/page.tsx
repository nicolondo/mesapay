import { db } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { MenuClient } from "./MenuClient";

export default async function MenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ table?: string; order?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const tableToken = sp.table;
  if (!tableToken) redirect(`/t/${slug}`);

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
  // the QR sees the current shared bill.
  const activeOrder = await db.order.findFirst({
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
      tenant={{ slug: tenant.slug, name: tenant.name, tagline: tenant.tagline }}
      tableId={table.id}
      tableNumber={table.number}
      categories={tenant.categories.map((c) => ({
        id: c.id,
        slug: c.slug,
        label: c.label,
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
          modifiers: m.modifiers as unknown as ModifierDef[] | null,
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

type ModifierDef = {
  id: string;
  label: string;
  type: "radio" | "checkbox";
  opts: string[];
  default?: string;
};
