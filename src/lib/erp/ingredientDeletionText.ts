// Eliminar insumos, del lado del navegador: las llamadas a la API y el texto
// de «No se puede eliminar: …». Sin Prisma ni React, para que Insumos e
// Inventario digan exactamente lo mismo y se pueda probar aislado. La regla
// vive en el server (`./ingredientDeletion`); acá solo se cuenta.

import type { Locale } from "@/i18n/config";
import { formatDate, localeTag } from "@/lib/format";
import type {
  IngredientDeletionCheck,
  IngredientDeletionReason,
  IngredientDeletionReasonCode,
  SkippedIngredient,
} from "./ingredientDeletion";

/** Tope de insumos por llamada masiva (la pantalla parte la selección). */
export const BULK_DELETE_MAX_IDS = 200;

type Translate = (key: string, values?: Record<string, string | number>) => string;

// «12 nov 2026», como la columna «Último movimiento» de Inventario.
const SHORT_DATE = { dateStyle: undefined, timeStyle: undefined, day: "numeric", month: "short", year: "numeric" } as const;

/** Motivo → clave i18n del namespace `opErp`. */
export const DELETION_REASON_KEYS: Record<IngredientDeletionReasonCode, string> = {
  stock: "delReasonStock",
  movements: "delReasonMovements",
  purchases: "delReasonPurchases",
  draftPurchases: "delReasonDraftPurchases",
  production: "delReasonProduction",
  closedCounts: "delReasonClosedCounts",
  draftCount: "delReasonDraftCount",
  recipes: "delReasonRecipes",
  modifierRecipes: "delReasonModifierRecipes",
  ownRecipe: "delReasonOwnRecipe",
  priceHistory: "delReasonPriceHistory",
  busy: "delReasonBusy",
};

function labelText(t: Translate, locale: Locale, reason: IngredientDeletionReason): string {
  const labels = reason.labels ?? [];
  const shown = labels.map((label) => {
    if (reason.code === "draftPurchases") return t("poNumber", { number: label.padStart(4, "0") });
    if (reason.code === "draftCount") return formatDate(label, { locale, ...SHORT_DATE });
    return label;
  });
  // Más de los que se nombran: «A, B, C…».
  return shown.join(", ") + (reason.count > shown.length && shown.length > 0 ? "…" : "");
}

/** «está en 3 recetas (Bandeja paisa, Ajiaco, Sancocho)». */
export function deletionReasonText(t: Translate, locale: Locale, reason: IngredientDeletionReason): string {
  return t(DELETION_REASON_KEYS[reason.code] ?? "delReasonBusy", {
    count: reason.count,
    list: labelText(t, locale, reason),
  });
}

/** Una lista en el idioma: «a, b y c» (con comas si el navegador es viejo). */
export function listText(locale: Locale, parts: string[]): string {
  try {
    return new Intl.ListFormat(localeTag(locale), { style: "long", type: "conjunction" }).format(parts);
  } catch {
    return parts.join(", ");
  }
}

/** Los motivos como una frase: «está en 3 recetas, tiene 12 movimientos y tiene existencias». */
export function deletionReasonsText(t: Translate, locale: Locale, reasons: IngredientDeletionReason[]): string {
  return listText(locale, reasons.map((reason) => deletionReasonText(t, locale, reason)));
}

/** Cuántos insumos saltados se nombran en el aviso antes de «y N más». */
export const MAX_SKIPPED_NAMED = 3;
/** Y cuántos motivos de cada uno (el detalle completo está en su ficha). */
export const MAX_SKIPPED_REASONS = 2;

/** «"Queso" (está en 2 recetas); "Sal" (tiene existencias) y 4 más». */
export function skippedIngredientsText(t: Translate, locale: Locale, skipped: SkippedIngredient[]): string {
  const named = skipped
    .slice(0, MAX_SKIPPED_NAMED)
    .map((row) => t("deleteSkippedItem", {
      name: row.name,
      reasons: deletionReasonsText(t, locale, row.reasons.slice(0, MAX_SKIPPED_REASONS)) + (row.reasons.length > MAX_SKIPPED_REASONS ? "…" : ""),
    }))
    .join("; ");
  const rest = skipped.length - MAX_SKIPPED_NAMED;
  return rest > 0 ? t("deleteSkippedMore", { list: named, count: rest }) : named;
}

function isReason(value: unknown): value is IngredientDeletionReason {
  const reason = value as IngredientDeletionReason | null;
  return !!reason && typeof reason.code === "string" && reason.code in DELETION_REASON_KEYS && typeof reason.count === "number"
    && (reason.labels === undefined || (Array.isArray(reason.labels) && reason.labels.every((label) => typeof label === "string")));
}

function parseReasons(value: unknown): IngredientDeletionReason[] | null {
  return Array.isArray(value) && value.length > 0 && value.every(isReason) ? value : null;
}

export type DeletionCheckResult =
  | { ok: true; check: IngredientDeletionCheck }
  | { ok: false; error: "not_found" | "failed" };

/** Pregunta al server si el insumo se puede eliminar (y por qué no). */
export async function fetchIngredientDeletionCheck(id: string): Promise<DeletionCheckResult> {
  try {
    const response = await fetch(`/api/operator/ingredients/${encodeURIComponent(id)}/delete`, { cache: "no-store" });
    if (response.status === 404) return { ok: false, error: "not_found" };
    if (!response.ok) return { ok: false, error: "failed" };
    const body = (await response.json()) as { deletable?: unknown; reasons?: unknown; removes?: Record<string, unknown> };
    if (body.deletable === true) {
      const count = (value: unknown) => (typeof value === "number" && value > 0 ? value : 0);
      return { ok: true, check: { deletable: true, removes: {
        barcodes: count(body.removes?.barcodes), supplierItems: count(body.removes?.supplierItems), invoiceAliases: count(body.removes?.invoiceAliases),
      } } };
    }
    const reasons = parseReasons(body.reasons);
    return body.deletable === false && reasons ? { ok: true, check: { deletable: false, reasons } } : { ok: false, error: "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export type DeleteIngredientResult =
  | { ok: true }
  | { ok: false; error: "not_deletable"; reasons: IngredientDeletionReason[] }
  | { ok: false; error: "not_found" | "conflict" | "failed" };

/** Elimina el insumo. Si el server dice que no se puede, trae los motivos. */
export async function deleteIngredient(id: string): Promise<DeleteIngredientResult> {
  try {
    const response = await fetch(`/api/operator/ingredients/${encodeURIComponent(id)}/delete`, { method: "DELETE" });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown; reasons?: unknown } | null;
    if (response.ok && body?.ok === true) return { ok: true };
    if (response.status === 404) return { ok: false, error: "not_found" };
    if (response.status === 409 && body?.error === "not_deletable") {
      const reasons = parseReasons(body.reasons);
      if (reasons) return { ok: false, error: "not_deletable", reasons };
    }
    if (response.status === 409 && body?.error === "conflict") return { ok: false, error: "conflict" };
    return { ok: false, error: "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

export type BulkDeleteResult = {
  deleted: { id: string; name: string }[];
  skipped: SkippedIngredient[];
  /** Ids cuyo lote falló (red, choque con otra operación): siguen ahí. */
  failed: string[];
};
export type BulkDeletePreview = Omit<BulkDeleteResult, "deleted"> & { deletable: { id: string; name: string }[] };

type NamedRow = { id: string; name: string };

function namedRows(value: unknown): NamedRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: NamedRow[] = [];
  for (const row of value as { id?: unknown; name?: unknown }[]) {
    if (typeof row?.id !== "string") return null;
    rows.push({ id: row.id, name: typeof row.name === "string" ? row.name : "" });
  }
  return rows;
}

function skippedRows(value: unknown): SkippedIngredient[] | null {
  if (!Array.isArray(value)) return null;
  const rows: SkippedIngredient[] = [];
  for (const row of value as { id?: unknown; name?: unknown; reasons?: unknown }[]) {
    const reasons = parseReasons(row?.reasons);
    if (typeof row?.id !== "string" || !reasons) return null;
    rows.push({ id: row.id, name: typeof row.name === "string" ? row.name : "", reasons });
  }
  return rows;
}

/** Una llamada por lote de `BULK_DELETE_MAX_IDS`; un lote que falla no
 *  detiene a los demás: sus ids vuelven en `failed`. */
async function bulkCall(ids: string[], dryRun: boolean, key: "deleted" | "deletable") {
  const out = { rows: [] as NamedRow[], skipped: [] as SkippedIngredient[], failed: [] as string[] };
  for (let start = 0; start < ids.length; start += BULK_DELETE_MAX_IDS) {
    const batch = ids.slice(start, start + BULK_DELETE_MAX_IDS);
    try {
      const response = await fetch("/api/operator/ingredients/bulk-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dryRun ? { ids: batch, dryRun: true } : { ids: batch }),
      });
      // 404 = ninguno de este lote existe ya: no hay nada que reportar.
      if (response.status === 404) continue;
      if (!response.ok) throw new Error("bulk_delete_failed");
      const body = (await response.json()) as Record<string, unknown>;
      const rows = namedRows(body[key]);
      const skipped = skippedRows(body.skipped);
      if (!rows || !skipped) throw new Error("bulk_delete_invalid");
      out.rows.push(...rows);
      out.skipped.push(...skipped);
    } catch {
      out.failed.push(...batch);
    }
  }
  return out;
}

/** Qué pasaría al eliminar estos insumos (no elimina nada). */
export async function previewIngredientsDeletion(ids: string[]): Promise<BulkDeletePreview> {
  const { rows, skipped, failed } = await bulkCall(ids, true, "deletable");
  return { deletable: rows, skipped, failed };
}

/** Elimina varios insumos; los que no se pueden vuelven con sus motivos. */
export async function deleteIngredients(ids: string[]): Promise<BulkDeleteResult> {
  const { rows, skipped, failed } = await bulkCall(ids, false, "deleted");
  return { deleted: rows, skipped, failed };
}
