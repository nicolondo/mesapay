// Llamadas del cliente que solo usa la hoja del conteo: a quién pertenece un
// código que no se encontró, sumar un insumo al borrador y restaurar un
// insumo archivado. Devuelven el código de error de la API tal cual; la
// hoja lo traduce con sus claves de `opErp`.

import type { ScanOwnerState } from "@/lib/erp/countView";
import type { CountDetail } from "./types";

export type ScanMatch = {
  ingredient: {
    id: string; name: string; active: boolean; trackInventory: boolean; category: string | null;
    barcode: string | null; barcodes: { barcode: string }[];
  };
  itemId: string | null;
  state: ScanOwnerState;
  scopeCategory: string | null;
  canAppend: boolean;
};

export type ScanLookup = { ok: true; match: ScanMatch | null } | { ok: false };

/** ¿De quién es este código? (null = de ningún insumo del comercio). */
export async function lookupCountScan(countId: string, code: string): Promise<ScanLookup> {
  try {
    const response = await fetch(`/api/operator/stock/counts/${countId}/scan?code=${encodeURIComponent(code)}`);
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as { match?: ScanMatch | null };
    return { ok: true, match: body.match ?? null };
  } catch {
    return { ok: false };
  }
}

export type AppendResult = { ok: true; count: CountDetail; itemId: string } | { ok: false; error: string };

/** Suma un insumo al conteo en borrador; devuelve el conteo con su revisión nueva. */
export async function appendCountItem(countId: string, revision: number, ingredientId: string): Promise<AppendResult> {
  try {
    const response = await fetch(`/api/operator/stock/counts/${countId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, ingredientId }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.count || typeof body.itemId !== "string") return { ok: false, error: typeof body?.error === "string" ? body.error : "failed" };
    return { ok: true, count: body.count as CountDetail, itemId: body.itemId };
  } catch {
    return { ok: false, error: "failed" };
  }
}

/** Restaura (desarchiva) un insumo. */
export async function restoreIngredient(id: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/operator/ingredients/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: true }),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ingredient?.id === id && body.ingredient.active === true;
  } catch {
    return false;
  }
}
