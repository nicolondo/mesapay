import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  dedupeModifierIds,
  normalizeModifiers,
  rekeyModifiers,
} from "@/lib/modifiers";

/**
 * Convierte una categoría (p.ej. "Vegetales", con sus productos como ítems
 * independientes) en UN modificador y lo agrega a un producto destino (p.ej.
 * una hamburguesa con "Adición de Vegetales"). Caso típico al importar cartas
 * que traen las adiciones como productos sueltos.
 *
 * El operador edita en el cliente la etiqueta, el tipo (radio/checkbox) y el
 * nombre/precio de cada opción; acá solo validamos y persistimos. Si pide
 * borrar el origen, borramos los productos sin historial y archivamos los que
 * ya se pidieron; la categoría se borra solo si queda vacía.
 */

const optSchema = z.object({
  label: z.string().trim().min(1).max(60),
  // Mismo rango que el precio base (hasta $1.000.000 en COP). El tope viejo de
  // $10.000 rechazaba adiciones legítimas (p.ej. proteína a $12.900 COP).
  priceDeltaCents: z.number().int().min(-100_000_000).max(100_000_000),
});

const bodySchema = z.object({
  targetItemId: z.string().min(1),
  label: z.string().trim().min(1).max(60),
  type: z.enum(["radio", "checkbox"]),
  options: z.array(optSchema).min(1).max(12),
  deleteSource: z.boolean(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: categoryId } = await params;
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
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const data = parsed.data;

  // La categoría origen y el producto destino deben ser del comercio activo.
  const [category, target] = await Promise.all([
    db.category.findFirst({
      where: { id: categoryId, restaurantId },
      select: { id: true },
    }),
    db.menuItem.findFirst({
      where: { id: data.targetItemId, restaurantId },
      select: { id: true, modifiers: true },
    }),
  ]);
  if (!category) {
    return NextResponse.json({ error: "invalid_category" }, { status: 400 });
  }
  if (!target) {
    return NextResponse.json({ error: "invalid_target" }, { status: 400 });
  }

  // Construimos el nuevo modificador con un id único que no choque con los del
  // producto destino, y lo ANEXAMOS (no reemplaza). Máximo 8 modificadores.
  const current = normalizeModifiers(target.modifiers);
  const [newMod] = rekeyModifiers(
    [{ id: "new", label: data.label, type: data.type, opts: data.options }],
    current.map((m) => m.id),
  );
  // current ya viene deduplicado y newMod usa un id que no choca con los
  // existentes; el dedupe final es un seguro explícito ante datos raros.
  const nextModifiers = dedupeModifierIds([...current, newMod]);
  if (nextModifiers.length > 8) {
    return NextResponse.json({ error: "too_many_modifiers" }, { status: 400 });
  }

  const result = await db.$transaction(async (tx) => {
    await tx.menuItem.update({
      where: { id: target.id },
      data: {
        modifiers: nextModifiers as unknown as Prisma.InputJsonValue,
      },
    });

    let deletedItemIds: string[] = [];
    let archivedItemIds: string[] = [];
    let deletedCategoryId: string | null = null;

    if (data.deleteSource) {
      // Productos de la categoría origen (nunca el destino, por las dudas).
      const sourceItems = await tx.menuItem.findMany({
        where: { categoryId, restaurantId, id: { not: target.id } },
        select: { id: true },
      });
      const sourceIds = sourceItems.map((s) => s.id);
      if (sourceIds.length > 0) {
        // Los que tienen historial de pedidos se ARCHIVAN (no se borran, para
        // no romper la cuenta histórica); el resto se borra de verdad.
        const used = await tx.orderItem.findMany({
          where: { menuItemId: { in: sourceIds } },
          select: { menuItemId: true },
          distinct: ["menuItemId"],
        });
        const usedSet = new Set(used.map((u) => u.menuItemId));
        archivedItemIds = sourceIds.filter((sid) => usedSet.has(sid));
        deletedItemIds = sourceIds.filter((sid) => !usedSet.has(sid));
        if (archivedItemIds.length > 0) {
          await tx.menuItem.updateMany({
            where: { id: { in: archivedItemIds } },
            data: { available: false },
          });
        }
        if (deletedItemIds.length > 0) {
          await tx.menuItem.deleteMany({
            where: { id: { in: deletedItemIds } },
          });
        }
      }
      // La categoría se borra solo si quedó vacía (sin ítems activos ni
      // archivados). Si quedaron archivados por historial, se mantiene.
      const remaining = await tx.menuItem.count({ where: { categoryId } });
      if (remaining === 0) {
        await tx.category.delete({ where: { id: categoryId } });
        deletedCategoryId = categoryId;
      }
    }

    return { deletedItemIds, archivedItemIds, deletedCategoryId };
  });

  return NextResponse.json({
    ok: true,
    targetItemId: target.id,
    modifiers: nextModifiers,
    deletedItemIds: result.deletedItemIds,
    archivedItemIds: result.archivedItemIds,
    deletedCategoryId: result.deletedCategoryId,
  });
}
