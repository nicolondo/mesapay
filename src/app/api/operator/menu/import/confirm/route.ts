import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { ensureDefaultMenu } from "@/lib/menus";

const itemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable(),
  // Tope alto: las cartas reales (importadas de Cluvi/Justo/Shopify)
  // incluyen botellas de licor premium que superan el millón. Queda bien
  // por debajo del máximo de un Int de Postgres (~2.147M).
  priceCents: z.number().int().min(0).max(2_000_000_000),
  // Either an id of an existing category or a slug of a new one (we
  // create it before the item if the slug doesn't match an existing id).
  categoryRef: z.union([
    z.object({ kind: z.literal("existing"), categoryId: z.string().min(1) }),
    z.object({
      kind: z.literal("new"),
      slug: z.string().trim().min(1).max(60),
      label: z.string().trim().min(1).max(80),
      categoryKind: z.enum([
        "starter",
        "main",
        "side",
        "drink",
        "dessert",
        "other",
      ]),
    }),
  ]),
  tags: z.array(z.string()).default([]),
  // Foto: o un /uploads/... local (descargado por el flujo de import) o una
  // URL https de un CDN de plataforma de menús confiable (Cluvi/Shopify/
  // Justo). Esto último cubre el caso en que la descarga server-side falla
  // (el CDN limita la IP del servidor): guardamos la URL remota y el
  // navegador del comensal la carga directo (la foto se pinta como CSS
  // background-image, sin SSRF de nuestro lado). Cualquier otra URL se
  // rechaza — defensa en profundidad.
  photoUrl: z
    .string()
    .max(2000)
    .refine(isAllowedPhotoUrl, { message: "untrusted photo url" })
    .nullable()
    .optional(),
});

// Hosts de CDN de las plataformas desde las que importamos cartas. El
// match por sufijo es seguro: solo la marca controla sus subdominios.
function isAllowedPhotoUrl(u: string): boolean {
  if (u.startsWith("/uploads/")) return true;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    const h = url.hostname.toLowerCase();
    return (
      h === "images.cluvi.com" ||
      h.endsWith(".getjusto.com") ||
      h.endsWith(".shopify.com") ||
      h.endsWith(".myshopify.com") ||
      h.endsWith(".shopifycdn.com")
    );
  } catch {
    return false;
  }
}

const schema = z.object({
  // Las cartas de bares grandes (con su lista de licores) pasan de 200
  // platos — son-y-melona tiene 223. Subimos el tope; el operador revisa
  // cada ítem en pantalla antes de confirmar.
  items: z.array(itemSchema).min(1).max(1000),
  // Optional target menu (e.g. "Vinos") for any *new* categories the
  // import creates. Existing categories matched by slug keep their
  // current menu. Omitted → default menu (Carta).
  menuId: z.string().min(1).optional(),
});

/**
 * Persist a reviewed menu. We process inside a single transaction so the
 * operator either gets all items or none — partial imports would leave
 * a confusing half-state.
 *
 * For new categories: dedupe by slug within this batch (multiple items
 * pointing to the same new slug share one new Category row).
 */
export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Collect distinct "new category" slugs so we create each only once.
  const newCategoriesBySlug = new Map<
    string,
    { label: string; kind: "starter" | "main" | "side" | "drink" | "dessert" | "other" }
  >();
  for (const it of parsed.data.items) {
    if (it.categoryRef.kind === "new") {
      newCategoriesBySlug.set(it.categoryRef.slug, {
        label: it.categoryRef.label,
        kind: it.categoryRef.categoryKind,
      });
    }
  }

  // For sortOrder of new categories we pick up where existing leave off.
  const lastCategory = await db.category.findFirst({
    where: { restaurantId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  let nextSort = (lastCategory?.sortOrder ?? -1) + 1;

  // Resolve which menu the new categories should land in. Validate the
  // operator-supplied menuId belongs to this restaurant; fall back to
  // ensureDefaultMenu so we always have a target. This is what enables
  // wine imports to land directly in a "Vinos" menu without polluting
  // the main Carta.
  let targetMenuId: string;
  if (parsed.data.menuId) {
    const menu = await db.menu.findUnique({
      where: { id: parsed.data.menuId },
      select: { restaurantId: true },
    });
    if (!menu || menu.restaurantId !== restaurantId) {
      return NextResponse.json({ error: "invalid_menu" }, { status: 400 });
    }
    targetMenuId = parsed.data.menuId;
  } else {
    const fallback = await ensureDefaultMenu(restaurantId);
    targetMenuId = fallback.id;
  }

  const result = await db.$transaction(async (tx) => {
    const slugToId = new Map<string, string>();

    // Look up existing categories already on this restaurant by slug so
    // we can reuse them if a "new" entry collides.
    const existing = await tx.category.findMany({
      where: { restaurantId },
      select: { id: true, slug: true },
    });
    for (const c of existing) slugToId.set(c.slug, c.id);

    for (const [slug, info] of newCategoriesBySlug) {
      if (slugToId.has(slug)) continue;
      // Smart default: when an imported menu has a drink category, send
      // it to the bar station out of the gate. Operators with no
      // bartender (hasBar=false) will see them fall through to the
      // waiter view, so this is safe even before they configure it.
      const prepStation = info.kind === "drink" ? "bar" : "kitchen";
      const created = await tx.category.create({
        data: {
          restaurantId,
          menuId: targetMenuId,
          slug,
          label: info.label,
          kind: info.kind,
          prepStation,
          sortOrder: nextSort++,
        },
      });
      slugToId.set(slug, created.id);
    }

    let nextItemSort = (
      await tx.menuItem.findFirst({
        where: { restaurantId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      })
    )?.sortOrder ?? -1;

    const createdItems: { id: string; name: string }[] = [];
    for (const it of parsed.data.items) {
      let categoryId: string;
      if (it.categoryRef.kind === "existing") {
        categoryId = it.categoryRef.categoryId;
      } else {
        const id = slugToId.get(it.categoryRef.slug);
        if (!id) throw new Error("category not created");
        categoryId = id;
      }
      const created = await tx.menuItem.create({
        data: {
          restaurantId,
          categoryId,
          name: it.name,
          description: it.description ?? null,
          priceCents: it.priceCents,
          tags: it.tags,
          photoUrl: it.photoUrl ?? null,
          sortOrder: ++nextItemSort,
          available: true,
        },
        select: { id: true, name: true },
      });
      createdItems.push(created);
    }
    return { items: createdItems };
  });

  return NextResponse.json({
    ok: true,
    createdCount: result.items.length,
    items: result.items,
  });
}
