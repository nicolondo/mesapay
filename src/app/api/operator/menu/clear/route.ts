import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Vaciar carta: borra todos los platos (y categorías vacías) del
 * restaurante activo, en una sola transacción. Pensado para re-importar
 * una carta desde cero sin borrar plato por plato.
 *
 * Seguridad de integridad: un MenuItem referenciado por pedidos
 * históricos (OrderItem.menuItemId es FK Restrict) no se puede borrar —
 * lo archivamos (available=false) para que salga de la carta sin perder
 * el historial. El mismo criterio que el DELETE de un solo plato.
 */
export async function POST() {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const result = await db.$transaction(async (tx) => {
    // Platos con pedidos: no se pueden borrar (FK). Se archivan.
    const usedRows = await tx.orderItem.findMany({
      where: { menuItem: { restaurantId } },
      select: { menuItemId: true },
      distinct: ["menuItemId"],
    });
    const usedIds = usedRows.map((r) => r.menuItemId);

    if (usedIds.length) {
      await tx.menuItem.updateMany({
        where: { restaurantId, id: { in: usedIds }, available: true },
        data: { available: false },
      });
    }

    // Borra todo lo demás (DishRating cae por cascade). notIn:[] en SQL es
    // problemático, así que separamos el caso sin platos usados.
    const del = usedIds.length
      ? await tx.menuItem.deleteMany({
          where: { restaurantId, id: { notIn: usedIds } },
        })
      : await tx.menuItem.deleteMany({ where: { restaurantId } });

    // Categorías que quedaron sin platos. Las que aún tienen un plato
    // archivado se conservan para que el operador vea dónde viven.
    const cats = await tx.category.deleteMany({
      where: { restaurantId, items: { none: {} } },
    });

    return {
      deleted: del.count,
      kept: usedIds.length,
      deletedCategories: cats.count,
    };
  });

  return NextResponse.json({ ok: true, ...result });
}
