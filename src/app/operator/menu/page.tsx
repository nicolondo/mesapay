import { auth } from "@/auth";
import { db } from "@/lib/db";
import { MenuEditor } from "./MenuEditor";

export const dynamic = "force-dynamic";

export default async function MenuAdminPage() {
  const session = await auth();
  const restaurantId = session!.user!.restaurantId;
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const [categories, items] = await Promise.all([
    db.category.findMany({
      where: { restaurantId },
      orderBy: { sortOrder: "asc" },
    }),
    db.menuItem.findMany({
      where: { restaurantId },
      orderBy: [{ categoryId: "asc" }, { sortOrder: "asc" }],
    }),
  ]);

  return (
    <MenuEditor
      categories={categories.map((c) => ({
        id: c.id,
        label: c.label,
        slug: c.slug,
      }))}
      items={items.map((i) => ({
        id: i.id,
        categoryId: i.categoryId,
        name: i.name,
        description: i.description ?? "",
        priceCents: i.priceCents,
        available: i.available,
        photoUrl: i.photoUrl ?? null,
        tags: i.tags,
        modifiers: (i.modifiers as unknown as ModifierDef[] | null) ?? [],
        prepMinutes: i.prepMinutes,
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
