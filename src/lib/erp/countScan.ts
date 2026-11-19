// Código escaneado en un conteo → de quién es y por qué no aparece.
//
// El navegador busca primero en lo que ya cargó (`buildCountBarcodeIndex`):
// si el código es de un insumo del conteo, salta a su fila sin ir al
// servidor. Cuando no lo encuentra, pregunta acá, y la respuesta sale del
// MISMO registro canónico que usa el alta de códigos (`IngredientBarcode`,
// único por comercio) y del mismo criterio (`classifyScanOwner`): así el
// escaneo, «ese código ya está en otro insumo» y esta explicación nunca se
// contradicen.
import { db } from "@/lib/db";
import { findBarcodeOwnerDetail, type BarcodeOwnerDetail } from "./barcodeOwner";
import { canAppendScanOwner, classifyScanOwner, countScopeCategories, type ScanOwnerState } from "./countView";

export type CountScanResult =
  | { code: string; match: null }
  | {
      code: string;
      match: {
        ingredient: BarcodeOwnerDetail;
        /** Fila del conteo cuando el insumo SÍ está (el navegador tenía datos viejos). */
        itemId: string | null;
        state: ScanOwnerState;
        /** Se puede sumar al conteo en curso con POST …/items. */
        canAppend: boolean;
      };
    };

export async function resolveCountScan(restaurantId: string, countId: string, code: string): Promise<CountScanResult | null> {
  const count = await db.stockCount.findFirst({
    where: { id: countId, restaurantId },
    select: {
      items: { select: { id: true, ingredientId: true, ingredient: { select: { category: true } } } },
      restaurant: { select: { inventoryExcludedCategories: true } },
    },
  });
  if (!count) return null;
  const owner = await findBarcodeOwnerDetail(restaurantId, code);
  if (!owner) return { code, match: null };
  const item = count.items.find((candidate) => candidate.ingredientId === owner.id);
  const state = classifyScanOwner(owner, {
    inCount: !!item,
    excludedCategories: count.restaurant.inventoryExcludedCategories,
    // El alcance son las categorías de los insumos del conteo (null =
    // «Sin categoría»): fuera de ellas se ofrece traer el insumo.
    scopeCategories: countScopeCategories(count.items),
  });
  return { code, match: { ingredient: owner, itemId: item?.id ?? null, state, canAppend: canAppendScanOwner(state) } };
}
