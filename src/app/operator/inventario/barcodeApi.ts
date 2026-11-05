// Llamadas del cliente a /api/operator/ingredients/[id]/barcode (agregar y
// quitar códigos) con los errores ya traducidos a claves i18n de `opErp`.
// Las usan la hoja «Códigos de barras» de Existencias y el alta rápida
// dentro del conteo, así los dos muestran exactamente los mismos mensajes.

import { normalizeBarcode, type IngredientBarcodeUpdate } from "@/lib/erp/barcode";

const ADD_ERRORS: Record<string, string> = {
  barcode_taken: "barcodeAddTaken",
  invalid: "barcodeAddInvalid",
  ingredient_inactive: "barcodeAddInactive",
  ingredient_not_tracked: "barcodeAddNotTracked",
  not_found: "barcodeAddUnavailable",
  forbidden: "barcodeAddUnavailable",
  unauthorized: "barcodeAddUnavailable",
  module_disabled: "barcodeAddUnavailable",
  operation_conflict: "barcodeAddConflict",
};

const REMOVE_ERRORS: Record<string, string> = {
  ...ADD_ERRORS,
  invalid: "barcodeRemoveFailed",
  barcode_not_found: "barcodeRemoveMissing",
};

export type BarcodeResult =
  | { ok: true; ingredient: IngredientBarcodeUpdate }
  | { ok: false; errorKey: string };

/** Código de error de la API → clave i18n (con un genérico de respaldo). */
export function barcodeErrorKey(code: unknown, mode: "add" | "remove"): string {
  const table = mode === "add" ? ADD_ERRORS : REMOVE_ERRORS;
  const fallback = mode === "add" ? "barcodeAddFailed" : "barcodeRemoveFailed";
  return typeof code === "string" && code in table ? table[code] : fallback;
}

/** La respuesta trae el registro completo del insumo (principal + demás). */
export function parseBarcodeResponse(id: string, body: unknown): IngredientBarcodeUpdate | null {
  const ingredient = (body as { ingredient?: unknown } | null)?.ingredient as Partial<IngredientBarcodeUpdate> | undefined;
  if (!ingredient || ingredient.id !== id || !Array.isArray(ingredient.barcodes)) return null;
  return ingredient as IngredientBarcodeUpdate;
}

async function send(id: string, method: "POST" | "DELETE", barcode: string, mode: "add" | "remove"): Promise<BarcodeResult> {
  try {
    const response = await fetch(`/api/operator/ingredients/${id}/barcode`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ barcode }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, errorKey: barcodeErrorKey(body?.error, mode) };
    const ingredient = parseBarcodeResponse(id, body);
    return ingredient ? { ok: true, ingredient } : { ok: false, errorKey: barcodeErrorKey(null, mode) };
  } catch {
    return { ok: false, errorKey: barcodeErrorKey(null, mode) };
  }
}

/** Agrega un código (limpia la basura del lector antes de mandarlo). */
export function addIngredientBarcode(id: string, raw: string): Promise<BarcodeResult> {
  const barcode = normalizeBarcode(raw);
  if (!barcode) return Promise.resolve({ ok: false, errorKey: "barcodeAddInvalid" });
  return send(id, "POST", barcode, "add");
}

/** Quita un código del insumo; si era el principal, otro toma su lugar. */
export function removeIngredientBarcode(id: string, barcode: string): Promise<BarcodeResult> {
  return send(id, "DELETE", barcode, "remove");
}
