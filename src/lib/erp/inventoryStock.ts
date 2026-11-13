import { db } from "@/lib/db";

/**
 * Existencias para /operator/inventario — la MISMA consulta para la carga
 * inicial de la página y para GET /api/operator/stock (que la refresca al
 * cerrar un conteo). Antes cada una armaba la suya y la API no excluía las
 * «categorías sin inventario»: al cerrar un conteo esos insumos aparecían.
 *
 * Se lista desde el INSUMO para incluir activos sin movimientos (nivel null
 * → 0). Los archivados solo si conservan saldo ≠ 0 (siguen siendo plata en
 * la bodega). Sin tope: la UI pagina y resume sobre el total.
 */
export async function loadInventoryStock(restaurantId: string, excludedCategories?: string[]) {
  const excluded = excludedCategories ?? (
    await db.restaurant.findUnique({ where: { id: restaurantId }, select: { inventoryExcludedCategories: true } })
  )?.inventoryExcludedCategories ?? [];
  const ingredients = await db.ingredient.findMany({
    where: {
      restaurantId,
      trackInventory: true,
      ...(excluded.length > 0
        ? { OR: [{ category: null }, { category: { notIn: excluded } }] }
        : {}),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      category: true,
      measureKind: true,
      active: true,
      barcode: true,
      barcodes: { where: { restaurantId }, select: { barcode: true }, orderBy: { barcode: "asc" } },
      // A4 — la UI marca "bajo mínimo" con qtyBase <= reorderPointBase.
      reorderPointBase: true,
      reorderQtyBase: true,
      // updatedAt del saldo = último movimiento (solo los movimientos lo tocan).
      stockLevel: { select: { qtyBase: true, totalValueCents: true, updatedAt: true } },
    },
  });
  return ingredients.filter((i) => i.active || (i.stockLevel && i.stockLevel.qtyBase !== 0));
}
