// Llamadas del cliente a /api/operator/ingredients/[id]/barcode (agregar,
// quitar, editar y pasar códigos) con los errores ya traducidos a claves
// i18n de `opErp`.
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

/** Insumo que ya tiene el código (mismo comercio): permite «pasárselo a este». */
export type BarcodeOwnerRef = { id: string; name: string; active: boolean };

export type BarcodeFailure = { ok: false; errorKey: string; errorValues?: Record<string, string>; owner?: BarcodeOwnerRef };

export type BarcodeResult =
  | { ok: true; ingredient: IngredientBarcodeUpdate }
  | BarcodeFailure;

/** Pasar un código devuelve los dos registros: quien lo soltó y quien lo recibió. */
export type BarcodeMoveResult =
  | { ok: true; ingredient: IngredientBarcodeUpdate; target: IngredientBarcodeUpdate }
  | BarcodeFailure;

/** Dueño del código en un 409 `barcode_taken` (null si la API no lo dijo). */
export function barcodeTakenOwner(body: unknown): BarcodeOwnerRef | null {
  const owner = (body as { owner?: Partial<BarcodeOwnerRef> | null } | null)?.owner;
  if (!owner || typeof owner.id !== "string" || !owner.id || typeof owner.name !== "string" || !owner.name) return null;
  return { id: owner.id, name: owner.name, active: owner.active !== false };
}

/**
 * «Ese código ya está en otro producto» dice CUÁL, y si está archivado: un
 * archivado no sale en el conteo ni en la lista, así que sin el nombre no
 * había cómo encontrar quién tenía el código.
 */
export function barcodeTakenError(body: unknown): { errorKey: string; errorValues?: Record<string, string> } {
  const owner = (body as { owner?: { name?: unknown; active?: unknown } | null } | null)?.owner;
  if (!owner || typeof owner.name !== "string" || owner.name === "") return { errorKey: "barcodeAddTaken" };
  return {
    errorKey: owner.active === false ? "barcodeAddTakenByArchived" : "barcodeAddTakenBy",
    errorValues: { name: owner.name },
  };
}

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
    if (!response.ok) {
      if (body?.error === "barcode_taken") return takenFailure(body);
      return { ok: false, errorKey: barcodeErrorKey(body?.error, mode) };
    }
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

function takenFailure(body: unknown): BarcodeFailure {
  const owner = barcodeTakenOwner(body);
  return { ok: false, ...barcodeTakenError(body), ...(owner ? { owner } : {}) };
}

// Editar el valor de un código (mismo insumo) y pasarlo a otro insumo.
const EDIT_ERRORS: Record<string, string> = {
  ...ADD_ERRORS,
  barcode_not_found: "barcodeRemoveMissing",
};
const MOVE_ERRORS: Record<string, string> = {
  ...ADD_ERRORS,
  invalid: "barcodeMoveFailed",
  barcode_not_found: "barcodeMoveMissing",
  target_not_found: "barcodeMoveTargetMissing",
  ingredient_inactive: "barcodeMoveTargetInactive",
  ingredient_not_tracked: "barcodeMoveTargetNotTracked",
};

/** Error de editar/pasar → clave i18n (con un genérico de respaldo). */
export function barcodeChangeErrorKey(code: unknown, mode: "edit" | "move"): string {
  const table = mode === "edit" ? EDIT_ERRORS : MOVE_ERRORS;
  const fallback = mode === "edit" ? "barcodeEditFailed" : "barcodeMoveFailed";
  return typeof code === "string" && code in table ? table[code] : fallback;
}

async function patch(id: string, payload: Record<string, string>, mode: "edit" | "move") {
  try {
    const response = await fetch(`/api/operator/ingredients/${id}/barcode`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const failure: BarcodeFailure = body?.error === "barcode_taken" ? takenFailure(body) : { ok: false, errorKey: barcodeChangeErrorKey(body?.error, mode) };
      return { failure, body: null };
    }
    return { failure: null, body };
  } catch {
    const failure: BarcodeFailure = { ok: false, errorKey: barcodeChangeErrorKey(null, mode) };
    return { failure, body: null };
  }
}

/** «Editar»: cambia el valor de un código del insumo (se digitó o escaneó mal). */
export async function replaceIngredientBarcode(id: string, barcode: string, raw: string): Promise<BarcodeResult> {
  const newBarcode = normalizeBarcode(raw);
  if (!newBarcode) return { ok: false, errorKey: "barcodeAddInvalid" };
  const { failure, body } = await patch(id, { barcode, newBarcode }, "edit");
  if (failure) return failure;
  const ingredient = parseBarcodeResponse(id, body);
  return ingredient ? { ok: true, ingredient } : { ok: false, errorKey: barcodeChangeErrorKey(null, "edit") };
}

/** Pasa un código de `sourceId` (quien lo tiene hoy) a `targetId`, en un paso. */
export async function moveIngredientBarcode(sourceId: string, barcode: string, targetId: string): Promise<BarcodeMoveResult> {
  const { failure, body } = await patch(sourceId, { barcode, moveTo: targetId }, "move");
  if (failure) return failure;
  const ingredient = parseBarcodeResponse(sourceId, body);
  const target = parseBarcodeResponse(targetId, { ingredient: (body as { target?: unknown } | null)?.target });
  return ingredient && target ? { ok: true, ingredient, target } : { ok: false, errorKey: barcodeChangeErrorKey(null, "move") };
}
