// Búsqueda de insumos por texto o por código de barras — LÓGICA PURA.
import { ingredientBarcodeValues, normalizeBarcode, type IngredientBarcodeFields } from "./barcode";

/** Sin tildes ni mayúsculas, para comparar texto. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export type SearchableIngredient = IngredientBarcodeFields & {
  name: string;
  category: string | null;
  sku?: string | null;
};

/**
 * ¿El insumo coincide con lo escrito (o escaneado) en el buscador?
 *
 * Texto: nombre, categoría o SKU, sin tildes ni mayúsculas. Código de
 * barras: cualquiera de sus códigos (el principal y los adicionales), con
 * la misma limpieza que al guardarlos, así que lo que teclea un lector
 * —con espacios o saltos de línea— encuentra el insumo. Un tramo del
 * código también sirve.
 */
export function ingredientMatchesSearch(ingredient: SearchableIngredient, query: string): boolean {
  const needle = fold(query.trim());
  if (!needle) return true;
  if (fold(`${ingredient.name} ${ingredient.category ?? ""} ${ingredient.sku ?? ""}`).includes(needle)) return true;
  const code = normalizeBarcode(query)?.toLowerCase();
  if (!code) return false;
  return ingredientBarcodeValues(ingredient).some((value) => value.toLowerCase().includes(code));
}
