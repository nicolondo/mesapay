import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveMenuTags } from "@/lib/menuTags";
import { pretranslateMenu } from "@/lib/translateMenu";
import { contentSourceHash } from "@/lib/translateContent";
import { locales, defaultLocale } from "@/i18n/config";

// El cobro de la carta con IA puede tardar (muchos platos → varias llamadas).
export const maxDuration = 300;

function guard(role?: string) {
  return (
    role === "operator" ||
    role === "platform_admin" ||
    role === "group_admin"
  );
}

/**
 * POST → genera/cachea con IA las traducciones de TODA la carta (en/pt).
 * Body { force?: true } → rehace las automáticas (conserva las manuales).
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const force = body?.force === true;
  try {
    const result = await pretranslateMenu(restaurantId, { force });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[menu-translations] generate failed", err);
    return NextResponse.json(
      {
        error: "translate_failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      { status: 502 },
    );
  }
}

const patchSchema = z.object({
  entityType: z.enum(["MenuItem", "Category", "Menu", "MenuTag"]),
  entityId: z.string().min(1),
  field: z.enum(["name", "description", "label"]),
  locale: z.string().min(2),
  // "" → borra el override (vuelve a la traducción automática / original).
  value: z.string().max(2000),
});

/** Devuelve el texto ORIGEN (es) de la entidad, validando que sea del comercio. */
async function sourceText(
  restaurantId: string,
  entityType: string,
  entityId: string,
  field: string,
): Promise<string | null> {
  if (entityType === "MenuItem") {
    const it = await db.menuItem.findFirst({
      where: { id: entityId, restaurantId },
      select: { name: true, description: true },
    });
    if (!it) return null;
    return field === "description" ? (it.description ?? "") : it.name;
  }
  if (entityType === "Category") {
    const c = await db.category.findFirst({
      where: { id: entityId, restaurantId },
      select: { label: true },
    });
    return c ? c.label : null;
  }
  if (entityType === "Menu") {
    const m = await db.menu.findFirst({
      where: { id: entityId, restaurantId },
      select: { label: true, description: true },
    });
    if (!m) return null;
    return field === "description" ? (m.description ?? "") : m.label;
  }
  if (entityType === "MenuTag") {
    const tenant = await db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { menuTags: true },
    });
    const tag = resolveMenuTags(tenant?.menuTags).find((t) => t.slug === entityId);
    return tag ? tag.label : null;
  }
  return null;
}

/**
 * PATCH → guarda (o borra) un override MANUAL de una traducción. source=
 * "manual" + sourceHash vigente → no lo pisa la regeneración con IA.
 */
export async function PATCH(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const { entityType, entityId, field, locale, value } = parsed.data;
  if (locale === defaultLocale || !locales.includes(locale as never)) {
    return NextResponse.json({ error: "bad_locale" }, { status: 400 });
  }

  const src = await sourceText(restaurantId, entityType, entityId, field);
  if (src === null) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const where = {
    entityType_entityId_field_locale: { entityType, entityId, field, locale },
  };
  const trimmed = value.trim();
  if (!trimmed) {
    // Borrar el override → vuelve a auto/original.
    await db.translation.deleteMany({
      where: { entityType, entityId, field, locale },
    });
    return NextResponse.json({ ok: true, cleared: true });
  }
  await db.translation.upsert({
    where,
    create: {
      entityType,
      entityId,
      field,
      locale,
      value: trimmed,
      source: "manual",
      sourceHash: contentSourceHash(src),
    },
    update: {
      value: trimmed,
      source: "manual",
      sourceHash: contentSourceHash(src),
    },
  });
  return NextResponse.json({ ok: true });
}
