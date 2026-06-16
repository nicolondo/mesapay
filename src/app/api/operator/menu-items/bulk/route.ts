import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { generateMenuDescriptions } from "@/lib/menuDescribe";
import {
  dedupeModifierIds,
  normalizeModifiers,
  rekeyModifiers,
} from "@/lib/modifiers";

// Acciones masivas sobre platos seleccionados en el editor de carta. Todo se
// hace EN INTERSECCIÓN con el restaurante activo: un payload armado a mano no
// puede tocar platos de otro comercio.

const idsSchema = z.array(z.string().min(1)).min(1).max(1000);

// Normaliza una etiqueta para comparar grupos de modificadores al COMBINAR:
// sin mayúsculas, sin acentos, sin espacios extra.
function normLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const schema = z.discriminatedUnion("action", [
  // Genera descripciones con IA pero NO las guarda: el operador las revisa y
  // confirma en el cliente (camino "previsualizar y confirmar").
  z.object({ action: z.literal("generate-descriptions"), itemIds: idsSchema }),
  // Guarda las descripciones (ya editadas/aprobadas por el operador).
  z.object({
    action: z.literal("set-descriptions"),
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          description: z.string().trim().max(500),
        }),
      )
      .min(1)
      .max(1000),
  }),
  z.object({
    action: z.literal("set-category"),
    itemIds: idsSchema,
    categoryId: z.string().min(1),
  }),
  z.object({
    action: z.literal("set-station"),
    itemIds: idsSchema,
    // null = heredar de la categoría (igual que el PATCH por plato).
    prepStation: z.enum(["kitchen", "bar", "counter"]).nullable(),
  }),
  // Copia el set de modificadores de un producto origen a los seleccionados.
  // replace = sobrescribe; merge = anexa sin duplicar grupos por etiqueta.
  z.object({
    action: z.literal("copy-modifiers"),
    itemIds: idsSchema,
    sourceItemId: z.string().min(1),
    mode: z.enum(["replace", "merge"]),
  }),
  z.object({ action: z.literal("delete"), itemIds: idsSchema }),
]);

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
  const data = parsed.data;

  if (data.action === "generate-descriptions") {
    const items = await db.menuItem.findMany({
      where: { id: { in: data.itemIds }, restaurantId },
      select: {
        id: true,
        name: true,
        // Categoría (hoja) + su padre (grupo/color) para darle a la IA el
        // contexto de subcategoría además de la categoría.
        category: {
          select: { label: true, parent: { select: { label: true } } },
        },
      },
    });
    try {
      const map = await generateMenuDescriptions(
        items.map((it) => ({
          id: it.id,
          name: it.name,
          categoryLabel: it.category?.label ?? "",
          parentCategoryLabel: it.category?.parent?.label ?? null,
        })),
      );
      // Devolvemos una propuesta por plato (vacía si el modelo no la generó).
      const results = items.map((it) => ({
        id: it.id,
        name: it.name,
        description: map.get(it.id) ?? "",
      }));
      return NextResponse.json({ ok: true, results });
    } catch (err) {
      console.error("[bulk describe] generación falló", err);
      return NextResponse.json({ error: "ai_failed" }, { status: 502 });
    }
  }

  if (data.action === "set-descriptions") {
    const owned = await db.menuItem.findMany({
      where: { id: { in: data.items.map((i) => i.id) }, restaurantId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((o) => o.id));
    const updates = data.items.filter((i) => ownedIds.has(i.id));
    if (updates.length > 0) {
      await db.$transaction(
        updates.map((u) =>
          db.menuItem.update({
            where: { id: u.id },
            data: { description: u.description.trim() || null },
          }),
        ),
      );
    }
    return NextResponse.json({ ok: true, count: updates.length });
  }

  if (data.action === "set-category") {
    const cat = await db.category.findFirst({
      where: { id: data.categoryId, restaurantId },
      select: { id: true },
    });
    if (!cat) {
      return NextResponse.json({ error: "invalid_category" }, { status: 400 });
    }
    const res = await db.menuItem.updateMany({
      where: { id: { in: data.itemIds }, restaurantId },
      data: { categoryId: data.categoryId },
    });
    return NextResponse.json({ ok: true, count: res.count });
  }

  if (data.action === "set-station") {
    const res = await db.menuItem.updateMany({
      where: { id: { in: data.itemIds }, restaurantId },
      data: { prepStation: data.prepStation },
    });
    return NextResponse.json({ ok: true, count: res.count });
  }

  if (data.action === "copy-modifiers") {
    const source = await db.menuItem.findFirst({
      where: { id: data.sourceItemId, restaurantId },
      select: { modifiers: true },
    });
    if (!source) {
      return NextResponse.json({ error: "invalid_source" }, { status: 400 });
    }
    const sourceMods = normalizeModifiers(source.modifiers);
    if (sourceMods.length === 0) {
      return NextResponse.json(
        { error: "source_no_modifiers" },
        { status: 400 },
      );
    }
    // El origen nunca se modifica a sí mismo.
    const targetIds = data.itemIds.filter((id) => id !== data.sourceItemId);
    if (targetIds.length === 0) {
      return NextResponse.json({ ok: true, count: 0, results: [] });
    }
    const targets = await db.menuItem.findMany({
      where: { id: { in: targetIds }, restaurantId },
      select: { id: true, modifiers: true },
    });
    const updates = targets.map((t) => {
      let next;
      if (data.mode === "replace") {
        // Ids nuevos: cada plato es dueño de los suyos.
        next = rekeyModifiers(sourceMods);
      } else {
        // merge: anexa solo los grupos cuya etiqueta no exista ya en el
        // destino, con ids que no choquen con los actuales.
        const current = normalizeModifiers(t.modifiers);
        const have = new Set(current.map((m) => normLabel(m.label)));
        const toAdd = sourceMods.filter((m) => !have.has(normLabel(m.label)));
        const appended = rekeyModifiers(
          toAdd,
          current.map((m) => m.id),
        );
        next = dedupeModifierIds([...current, ...appended]);
      }
      return { id: t.id, modifiers: next };
    });
    await db.$transaction(
      updates.map((u) =>
        db.menuItem.update({
          where: { id: u.id },
          data: {
            modifiers: u.modifiers as unknown as Prisma.InputJsonValue,
          },
        }),
      ),
    );
    // Devolvemos los modifiers resultantes por plato para que el editor
    // parchee su estado local sin recargar.
    return NextResponse.json({
      ok: true,
      count: updates.length,
      results: updates,
    });
  }

  // delete: los platos con pedidos históricos se ARCHIVAN (available=false) en
  // vez de borrarse, para no romper el histórico (mismo criterio que el DELETE
  // por plato). El resto se borra de verdad.
  const owned = await db.menuItem.findMany({
    where: { id: { in: data.itemIds }, restaurantId },
    select: { id: true },
  });
  const ownedIds = owned.map((o) => o.id);
  if (ownedIds.length === 0) {
    return NextResponse.json({ ok: true, deletedIds: [], archivedIds: [] });
  }
  const used = await db.orderItem.findMany({
    where: { menuItemId: { in: ownedIds } },
    select: { menuItemId: true },
    distinct: ["menuItemId"],
  });
  const archivedIds = used.map((u) => u.menuItemId);
  const archivedSet = new Set(archivedIds);
  const deletableIds = ownedIds.filter((id) => !archivedSet.has(id));
  await db.$transaction([
    ...(archivedIds.length
      ? [
          db.menuItem.updateMany({
            where: { id: { in: archivedIds } },
            data: { available: false },
          }),
        ]
      : []),
    ...(deletableIds.length
      ? [db.menuItem.deleteMany({ where: { id: { in: deletableIds } } })]
      : []),
  ]);
  return NextResponse.json({ ok: true, deletedIds: deletableIds, archivedIds });
}
