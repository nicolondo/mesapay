// Emparejamiento de un catálogo de insumos importado con el catálogo
// existente del comercio (ERP inventory) — LÓGICA PURA, sin DB ni IA. El
// caller precarga los insumos y categorías; acá se decide qué ya existe
// (para no duplicar) y qué categoría reusar. Nada se persiste.
import { fold } from "@/lib/erp/invoiceMatch";
import type { InventoryImportExtraction, InventoryImportRowType } from "@/lib/anthropic";

const LOW_CONFIDENCE = 0.7;

export type IngredientRef = { id: string; name: string };

export type InventoryMatchRow = {
  row: InventoryImportRowType;
  lowConfidence: boolean;
  /** Insumo existente que coincide por nombre (fold exacto), o null = se creará. */
  matchedIngredientId: string | null;
  matchedIngredientName: string | null;
  /** Categoría reusada del comercio si la sugerida coincide (fold); si no, la sugerida. */
  category: string | null;
};

export type InventoryMatchContext = {
  ingredients: IngredientRef[];
  /** Categorías existentes del comercio (para reusar en vez de duplicar). */
  categories: string[];
};

export type InventoryMatch = {
  rows: InventoryMatchRow[];
  newCount: number;
  existingCount: number;
};

/**
 * Empareja el catálogo importado. Dedup CONSERVADOR: solo se considera
 * "ya existe" cuando el nombre coincide exacto (accent/case-insensitive) —
 * evita fusionar insumos distintos ("Aceite" vs "Aceite de oliva"). La
 * categoría se reusa si coincide con una del comercio.
 */
export function matchInventory(
  extraction: InventoryImportExtraction,
  ctx: InventoryMatchContext,
): InventoryMatch {
  const byName = new Map(ctx.ingredients.map((i) => [fold(i.name), i]));
  const catByFold = new Map(ctx.categories.map((c) => [fold(c), c]));

  const rows = extraction.rows.map((row): InventoryMatchRow => {
    const matched = byName.get(fold(row.name)) ?? null;
    const suggested = row.category?.trim() || null;
    const category = suggested
      ? (catByFold.get(fold(suggested)) ?? suggested)
      : null;
    return {
      row,
      lowConfidence: row.confidence < LOW_CONFIDENCE,
      matchedIngredientId: matched?.id ?? null,
      matchedIngredientName: matched?.name ?? null,
      category,
    };
  });

  const existingCount = rows.filter((r) => r.matchedIngredientId).length;
  return { rows, newCount: rows.length - existingCount, existingCount };
}

/**
 * Sanea la salida de la IA antes de matchear: recorta nombres/categorías,
 * descarta filas sin nombre.
 */
export function normalizeInventoryExtraction(
  raw: InventoryImportExtraction,
): InventoryImportExtraction {
  const rows = raw.rows
    .map((r) => ({
      ...r,
      name: r.name.trim(),
      category: r.category?.trim() || null,
    }))
    .filter((r) => r.name.length > 0);
  return { ...raw, rows };
}
