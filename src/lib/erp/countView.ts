// Lógica pura de la hoja «Conteo físico» (/operator/inventario → Conteos):
// el orden «lo último que toqué, arriba», los filtros, el resumen de las
// cantidades parciales de una fila y la resolución de un código escaneado.
// Sin React ni Prisma: la usan la hoja y la API, y se prueba aislada.

import { ingredientBarcodeValues, type IngredientBarcodeFields } from "./barcode";
import { ingredientMatchesSearch, type SearchableIngredient } from "./ingredientSearch";
import { parseCountEntry, type CountEntry } from "./stockCountInput";
import type { MeasureKind } from "./units";

/* ───────────────────────── Orden: recientes primero ───────────────────── */

/**
 * `touched[itemId]` = turno en que se tocó por última vez (más alto = más
 * reciente). `editing` es la fila en la que se está tecleando: todavía NO
 * cuenta para el orden, así la fila no salta mientras se escribe.
 */
export type CountOrderState = {
  seq: number;
  touched: Readonly<Record<string, number>>;
  editing: string | null;
};

export const EMPTY_COUNT_ORDER: CountOrderState = { seq: 0, touched: {}, editing: null };

export type CountOrderAction =
  /** Lectura del escáner (o salto directo a un insumo): sube de inmediato. */
  | { type: "scan"; itemId: string }
  /** Se cambió algo en la fila (cantidad, unidad, una parte): no reordena. */
  | { type: "edit"; itemId: string }
  /** El foco salió de la fila o se pulsó Enter: ahora sí sube lo editado. */
  | { type: "commit"; itemId?: string }
  /** Nueva etapa del conteo (las cantidades vuelven a estar vacías). */
  | { type: "reset" };

function touch(state: CountOrderState, itemId: string): CountOrderState {
  const seq = state.seq + 1;
  return { seq, touched: { ...state.touched, [itemId]: seq }, editing: state.editing === itemId ? null : state.editing };
}

export function countOrderReducer(state: CountOrderState, action: CountOrderAction): CountOrderState {
  switch (action.type) {
    case "scan": {
      // Si quedó otra fila a medio editar, entra primero (queda debajo).
      const settled = state.editing && state.editing !== action.itemId ? touch(state, state.editing) : state;
      return touch({ ...settled, editing: null }, action.itemId);
    }
    case "edit": {
      if (state.editing === action.itemId) return state;
      const settled = state.editing ? touch(state, state.editing) : state;
      return { ...settled, editing: action.itemId };
    }
    case "commit": {
      if (!state.editing || (action.itemId !== undefined && action.itemId !== state.editing)) return state;
      return touch(state, state.editing);
    }
    case "reset":
      return state === EMPTY_COUNT_ORDER ? state : EMPTY_COUNT_ORDER;
  }
}

/**
 * Parte la lista en «contados recientemente» (por último toque, el más
 * nuevo arriba) y el resto en su orden de siempre. Los ids desconocidos del
 * mapa se ignoran.
 */
export function orderCountItems<T extends { id: string }>(
  items: readonly T[],
  touched: Readonly<Record<string, number>>,
): { recent: T[]; rest: T[] } {
  const recent: T[] = [];
  const rest: T[] = [];
  for (const item of items) (touched[item.id] !== undefined ? recent : rest).push(item);
  recent.sort((a, b) => touched[b.id] - touched[a.id]);
  return { recent, rest };
}

/** Orden guardado en el dispositivo al guardar el borrador (por etapa). */
export type StoredCountOrder = { phase: string; ids: string[] };

/** Ids de más reciente a más viejo, listos para guardar. */
export function serializeCountOrder(state: CountOrderState, phase: string): StoredCountOrder {
  const ids = Object.keys(state.touched).sort((a, b) => state.touched[b] - state.touched[a]);
  return { phase, ids };
}

/**
 * Reconstruye el orden al reabrir el borrador. Solo vale para la misma
 * etapa y para insumos que siguen en el conteo CON cantidad guardada: lo
 * que se tocó y se descartó sin guardar no vuelve a quedar arriba.
 */
export function restoreCountOrder(
  stored: unknown,
  phase: string,
  items: readonly { id: string; countedQty: number | null }[],
): CountOrderState {
  const value = stored as Partial<StoredCountOrder> | null;
  if (!value || value.phase !== phase || !Array.isArray(value.ids)) return EMPTY_COUNT_ORDER;
  const counted = new Set(items.filter((item) => item.countedQty !== null).map((item) => item.id));
  const ids = [...new Set(value.ids.filter((id): id is string => typeof id === "string" && counted.has(id)))];
  if (!ids.length) return EMPTY_COUNT_ORDER;
  const touched: Record<string, number> = {};
  ids.forEach((id, index) => { touched[id] = ids.length - index; });
  return { seq: ids.length, touched, editing: null };
}

/* ─────────────────────────────── Filtros ───────────────────────────────── */

export type DifferenceFilter = "all" | "shortage" | "surplus" | "pending";

export type CountFilterView = {
  ingredient: SearchableIngredient;
  tracked: boolean;
  /** Cantidad con la que se filtra (base); null = sin contar. */
  value: number | null | "invalid";
  /** Existencia contra la que se compara. */
  baseline: number;
};

/**
 * Buscador (nombre, categoría o código de barras) + filtro de diferencias.
 * `pinned` siempre pasa: es la fila que se acaba de escanear o en la que se
 * está escribiendo, y no puede desaparecer por un filtro.
 */
export function filterCountItems<T extends { id: string }>(
  items: readonly T[],
  options: { q: string; filter: DifferenceFilter; view: (item: T) => CountFilterView; pinned?: ReadonlySet<string> },
): T[] {
  return items.filter((item) => {
    if (options.pinned?.has(item.id)) return true;
    const view = options.view(item);
    if (!ingredientMatchesSearch(view.ingredient, options.q)) return false;
    if (options.filter === "all") return true;
    if (!view.tracked) return false;
    if (options.filter === "pending") return view.value == null;
    if (view.value == null || view.value === "invalid") return false;
    return options.filter === "shortage" ? view.value < view.baseline : view.value > view.baseline;
  });
}

/* ───────────────────────── Estado y resumen de la fila ─────────────────── */

export type CountRowState = "untracked" | "pending" | "invalid" | "equal" | "shortage" | "surplus";

export function countRowState(value: number | null | "invalid", baseline: number, tracked: boolean): CountRowState {
  if (!tracked) return "untracked";
  if (value === "invalid") return "invalid";
  if (value == null) return "pending";
  return value === baseline ? "equal" : value < baseline ? "shortage" : "surplus";
}

export type CountStats = { counted: number; diffs: number; shortages: number; surpluses: number; equal: number; pending: number };

/** Contadores de la tira de filtros (los no inventariables no cuentan). */
export function countStats(states: Iterable<CountRowState>): CountStats {
  const stats: CountStats = { counted: 0, diffs: 0, shortages: 0, surpluses: 0, equal: 0, pending: 0 };
  for (const state of states) {
    if (state === "untracked") continue;
    if (state === "pending" || state === "invalid") { stats.pending++; continue; }
    stats.counted++;
    if (state === "equal") stats.equal++;
    else { stats.diffs++; if (state === "shortage") stats.shortages++; else stats.surpluses++; }
  }
  return stats;
}

/**
 * Cantidades parciales de una fila: cuántas hay, cuántas ya tienen un valor
 * válido y si alguna está mal. Con una sola, la fila muestra el campo en
 * línea; con varias, el total y el chip «N cantidades».
 */
export function summarizeCountParts(entries: readonly CountEntry[], kind: MeasureKind): { parts: number; filled: number; invalid: boolean; multi: boolean } {
  let filled = 0;
  let invalid = false;
  for (const entry of entries) {
    const value = parseCountEntry(entry.raw, kind, entry.unit);
    if (value === "invalid") invalid = true;
    else if (value !== null) filled++;
  }
  return { parts: entries.length, filled, invalid, multi: entries.length > 1 };
}

/**
 * Al soltar la fila se descartan las cantidades que quedaron en blanco (un
 * escaneo sin digitar): no son cero ni suman. Siempre queda al menos un
 * campo, y lo inválido se conserva para que se corrija.
 */
export function pruneBlankCountParts(entries: readonly CountEntry[]): CountEntry[] {
  if (entries.length <= 1) return [...entries];
  const kept = entries.filter((entry) => entry.raw.trim() !== "");
  return kept.length ? kept : [entries[0]];
}

/* ─────────────────── Código escaneado → insumo del conteo ──────────────── */

type CountBarcodeItem = { id: string; ingredient: IngredientBarcodeFields };

/**
 * Índice código → fila del conteo, con todos los códigos de cada insumo (el
 * principal y los adicionales) ya normalizados. Es lo que consulta el
 * escaneo en el navegador; la API responde lo mismo con `resolveCountScan`.
 */
export function buildCountBarcodeIndex(items: readonly CountBarcodeItem[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const item of items) {
    for (const code of ingredientBarcodeValues(item.ingredient)) index.set(code, item.id);
  }
  return index;
}

/** Categoría del conteo cuando se creó para una sola; null = todos los insumos. */
export function countScopeCategory(items: readonly { ingredient: { category: string | null } }[]): string | null {
  if (items.length === 0) return null;
  const first = items[0].ingredient.category;
  if (!first) return null;
  return items.every((item) => item.ingredient.category === first) ? first : null;
}

/** Por qué el dueño de un código NO está en este conteo. */
export type ScanOwnerState =
  | "in_count"
  | "archived"
  | "not_tracked"
  | "category_excluded"
  | "outside_scope"
  | "added_later";

export type ScanOwner = { id: string; name: string; active: boolean; trackInventory: boolean; category: string | null };

/**
 * Un solo criterio para el navegador y la API: primero si el insumo está en
 * el conteo; si no, la razón más específica — archivado, no inventariable,
 * de una categoría sin inventario, fuera de la categoría del conteo o
 * creado/restaurado después de abrirlo.
 */
export function classifyScanOwner(
  owner: ScanOwner,
  context: { inCount: boolean; excludedCategories: readonly string[]; scopeCategory: string | null },
): ScanOwnerState {
  if (context.inCount) return "in_count";
  if (!owner.active) return "archived";
  if (!owner.trackInventory) return "not_tracked";
  if (owner.category && context.excludedCategories.includes(owner.category)) return "category_excluded";
  if (context.scopeCategory && owner.category !== context.scopeCategory) return "outside_scope";
  return "added_later";
}

/** ¿Se puede sumar ese insumo al conteo en curso? (activo e inventariable). */
export function canAppendScanOwner(state: ScanOwnerState): boolean {
  return state === "outside_scope" || state === "added_later";
}
