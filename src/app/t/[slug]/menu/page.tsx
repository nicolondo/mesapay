import { db } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { MenuClient } from "./MenuClient";

export default async function MenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ table?: string }>;
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

  const table = await db.table.findUnique({ where: { qrToken: tableToken } });
  if (!table || table.restaurantId !== tenant.id) {
    return notFound();
  }

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
      items={tenant.menuItems.map((m) => ({
        id: m.id,
        categoryId: m.categoryId,
        name: m.name,
        description: m.description ?? "",
        priceCents: m.priceCents,
        tags: m.tags,
        photoUrl: m.photoUrl ?? null,
        modifiers: m.modifiers as unknown as ModifierDef[] | null,
      }))}
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
