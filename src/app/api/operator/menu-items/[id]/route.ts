import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { MAX_TAGS_PER_ITEM, SLUG_REGEX } from "@/lib/menuTags";
import { isAllowedMenuPhotoUrl } from "@/lib/menuPhotoUrl";
import { dedupeModifierIds } from "@/lib/modifiers";

// Accept both shapes for the option list:
//   "Pollo"                            (legacy, no price delta)
//   { label: "Camarón", priceDeltaCents: 500000 }
// The string form is rewritten to the object form on parse so the rest
// of the code only deals with one type.
const modOptSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .max(60)
    .transform((label) => ({ label }) as { label: string; priceDeltaCents?: number }),
  z.object({
    label: z.string().trim().min(1).max(60),
    // Mismo rango que el precio base (hasta $1.000.000 en COP). El tope viejo
    // de $10.000 rechazaba adiciones legítimas (p.ej. proteína a $12.900 COP).
    priceDeltaCents: z.number().int().min(-100_000_000).max(100_000_000).optional(),
    description: z.string().trim().max(200).optional(),
  }),
]);

const modifierSchema = z.object({
  id: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(60),
  type: z.enum(["radio", "checkbox"]),
  opts: z.array(modOptSchema).min(1).max(12),
  default: z.string().trim().max(60).optional(),
  // Grupo obligatorio: el comensal debe elegir al menos una opción para agregar.
  required: z.boolean().optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  priceCents: z.number().int().min(0).max(100_000_000).optional(),
  // 500 para alinear con el importador de carta (descripciones largas de
  // PDFs/Cluvi). El menú del comensal trunca con line-clamp igual.
  description: z.string().trim().max(500).nullable().optional(),
  categoryId: z.string().min(1).optional(),
  available: z.boolean().optional(),
  // Foto: el host se valida ABAJO, y solo si la foto cambió respecto a la ya
  // guardada. Re-validar una URL ya almacenada al editar otro campo (p.ej.
  // descripción o modificadores) la rechazaba sin motivo. Acá solo un tope de
  // tamaño generoso (URLs firmadas de CDN pueden ser largas).
  photoUrl: z.string().trim().max(4000).nullable().optional(),
  // Tags are now a per-restaurant registry (see /operator/settings/etiquetas),
  // so we only enforce shape here — that they look like slugs. The
  // diner-side renderer ignores unknown slugs, so a desync between an
  // item's tags and the registry never breaks the page.
  tags: z.array(z.string().regex(SLUG_REGEX)).max(MAX_TAGS_PER_ITEM).optional(),
  modifiers: z.array(modifierSchema).max(8).nullable().optional(),
  prepMinutes: z.number().min(0.1).max(120).optional(),
  // Override the category's default station for this specific item.
  // null = inherit from category (the common case). The frontend sends
  // null when the operator picks "Usar la de la categoría".
  prepStation: z.enum(["kitchen", "bar", "counter"]).nullable().optional(),
});

async function guard(id: string) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return { error: "unauthorized" as const };
  }
  const item = await db.menuItem.findUnique({ where: { id } });
  if (!item) return { error: "not found" as const };
  const activeId = await getActiveRestaurantId();
  if (item.restaurantId !== activeId) {
    return { error: "forbidden" as const };
  }
  return { item, session };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    // Devolvemos el campo que falló para que el editor no muestre un
    // "invalid" opaco.
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: "invalid",
        field: issue?.path.join(".") || null,
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  // Validamos el host de la foto SOLO si cambió respecto a la guardada. Una
  // foto que el operador no tocó (la dejó tal cual al editar descripción o
  // modificadores) nunca se rechaza, aunque su URL sea de un host/longitud
  // que hoy no aceptaríamos: ya estaba almacenada. Una foto NUEVA distinta de
  // null sí pasa por el allowlist (subidas dan /uploads/, que es válido).
  if (
    parsed.data.photoUrl !== undefined &&
    parsed.data.photoUrl !== null &&
    parsed.data.photoUrl !== g.item.photoUrl &&
    !isAllowedMenuPhotoUrl(parsed.data.photoUrl)
  ) {
    return NextResponse.json(
      { error: "invalid", field: "photoUrl", issues: [] },
      { status: 400 },
    );
  }

  if (parsed.data.categoryId) {
    const cat = await db.category.findUnique({
      where: { id: parsed.data.categoryId },
    });
    if (!cat || cat.restaurantId !== g.item.restaurantId) {
      return NextResponse.json({ error: "invalid category" }, { status: 400 });
    }
  }

  const data: Prisma.MenuItemUncheckedUpdateInput = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.priceCents !== undefined) data.priceCents = parsed.data.priceCents;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.categoryId !== undefined) data.categoryId = parsed.data.categoryId;
  if (parsed.data.available !== undefined) data.available = parsed.data.available;
  if (parsed.data.photoUrl !== undefined) data.photoUrl = parsed.data.photoUrl;
  if (parsed.data.tags !== undefined) data.tags = parsed.data.tags;
  if (parsed.data.modifiers !== undefined) {
    // Garantizar ids de modificador únicos antes de persistir: si llegan
    // repetidos (datos viejos reabiertos en el editor, etc.) el picker del
    // comensal y la comanda los confunden. dedupeModifierIds muta in situ.
    data.modifiers =
      parsed.data.modifiers === null
        ? Prisma.DbNull
        : (dedupeModifierIds(
            parsed.data.modifiers,
          ) as unknown as Prisma.InputJsonValue);
  }
  if (parsed.data.prepMinutes !== undefined) data.prepMinutes = parsed.data.prepMinutes;
  if (parsed.data.prepStation !== undefined) data.prepStation = parsed.data.prepStation;

  await db.menuItem.update({ where: { id }, data });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: 403 });

  const used = await db.orderItem.count({ where: { menuItemId: id } });
  if (used > 0) {
    // Keep record for historical orders — just mark unavailable.
    await db.menuItem.update({
      where: { id },
      data: { available: false },
    });
    return NextResponse.json({ ok: true, archived: true });
  }
  await db.menuItem.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
