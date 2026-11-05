// Lógica pura de la vista de Inventario (/operator/inventario): filtros,
// orden, resumen, contadores de los chips y paginación de las existencias.
// Sin React ni Prisma, para poder probarla aislada y para que la tabla, las
// tarjetas del celular y la tira de resumen usen exactamente el mismo
// conjunto filtrado.

import { ingredientBarcodeValues } from "./barcode";
import { displayUnitFor, type MeasureKind } from "./units";

export type StockLevelView = {
  qtyBase: number;
  totalValueCents: number;
  updatedAt: string | Date;
};

export type StockRowView = {
  id: string;
  name: string;
  category: string | null;
  measureKind: MeasureKind;
  active: boolean;
  barcode: string | null;
  barcodes: { barcode: string }[];
  /** A4 — punto de reorden (null = sin aviso) y cantidad sugerida de compra. */
  reorderPointBase: number | null;
  reorderQtyBase: number | null;
  stockLevel: StockLevelView | null;
};

/** Orden de la tabla de existencias: cada columna con sus dos direcciones. */
export type StockSort =
  | "name"
  | "nameDesc"
  | "qtyDesc"
  | "qtyAsc"
  | "valueDesc"
  | "valueAsc"
  | "avgDesc"
  | "avgAsc"
  | "movedDesc"
  | "movedAsc";

export type StockSortColumn = "name" | "qty" | "avg" | "value" | "moved";

export const STOCK_SORTS: readonly StockSort[] = [
  "name", "nameDesc", "qtyDesc", "qtyAsc", "valueDesc", "valueAsc", "avgDesc", "avgAsc", "movedDesc", "movedAsc",
];

export type StockFilters = {
  q: string;
  /** "all" o el nombre exacto de la categoría. */
  category: string;
  lowOnly: boolean;
  stockedOnly: boolean;
  showArchived: boolean;
};

export const DEFAULT_STOCK_FILTERS: StockFilters = {
  q: "", category: "all", lowOnly: false, stockedOnly: false, showArchived: false,
};

/** Búsqueda sin acentos: minúsculas + tildes fuera ("azucar" → "azúcar"). */
export function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const qty = (r: StockRowView) => r.stockLevel?.qtyBase ?? 0;
const value = (r: StockRowView) => r.stockLevel?.totalValueCents ?? 0;

/**
 * "Bajo mínimo" (spec A4·D3): existencia actual ≤ punto de reorden,
 * negativos incluidos; sin nivel de stock cuenta como 0. Insumos sin
 * punto de reorden nunca alertan, y los archivados tampoco — no tiene
 * sentido pedir un insumo descatalogado.
 */
export function isLowStock(r: StockRowView): boolean {
  return r.active && r.reorderPointBase != null && qty(r) <= r.reorderPointBase;
}

/** Estado del mínimo para pintar la fila: sin punto, en orden o bajo. */
export function reorderState(r: StockRowView): "none" | "ok" | "low" {
  if (r.reorderPointBase == null || !r.active) return "none";
  return isLowStock(r) ? "low" : "ok";
}

/**
 * Costo unitario en la unidad de display de la existencia (p. ej. $/kg).
 * Sin existencias positivas no hay promedio que mostrar → null.
 */
export function unitCost(r: StockRowView): { cents: number; symbol: string } | null {
  const q = qty(r);
  if (q <= 0) return null;
  const unit = displayUnitFor(q, r.measureKind);
  return { cents: Math.round((value(r) / q) * unit.factor), symbol: unit.symbol };
}

/** Texto donde busca el buscador: nombre, categoría y códigos de barras. */
function haystack(r: StockRowView): string {
  return fold(`${r.name} ${r.category ?? ""} ${ingredientBarcodeValues(r).join(" ")}`);
}

/** Búsqueda + categoría: la base sobre la que se cuentan los chips. */
function matchesScope(r: StockRowView, needle: string, category: string): boolean {
  if (category !== "all" && r.category !== category) return false;
  if (needle && !haystack(r).includes(needle)) return false;
  return true;
}

/** Filtra y ordena las existencias. Recibe el orden del server (A→Z). */
export function filterStockRows(rows: StockRowView[], f: StockFilters, sort: StockSort): StockRowView[] {
  const needle = fold(f.q.trim());
  const out = rows.filter((r) => {
    if (!f.showArchived && !r.active) return false;
    if (f.lowOnly && !isLowStock(r)) return false;
    if (f.stockedOnly && qty(r) === 0) return false;
    return matchesScope(r, needle, f.category);
  });
  return sortStockRows(out, sort);
}

const time = (r: StockRowView) => (r.stockLevel ? new Date(r.stockLevel.updatedAt).getTime() : Number.NEGATIVE_INFINITY);
// Costo unitario comparable entre dimensiones: valor/cantidad base (el
// factor del símbolo es constante por fila y no cambia el orden relativo).
const avg = (r: StockRowView) => (qty(r) > 0 ? value(r) / qty(r) : -1);
const byName = (a: StockRowView, b: StockRowView) => a.name.localeCompare(b.name);

// Por nombre, alfabético puro: los archivados que se muestran quedan en su
// lugar (marcados), no al final de otra página.
const COMPARE: Record<StockSort, (a: StockRowView, b: StockRowView) => number> = {
  name: byName,
  nameDesc: (a, b) => byName(b, a),
  qtyDesc: (a, b) => qty(b) - qty(a),
  qtyAsc: (a, b) => qty(a) - qty(b),
  valueDesc: (a, b) => value(b) - value(a),
  valueAsc: (a, b) => value(a) - value(b),
  avgDesc: (a, b) => avg(b) - avg(a),
  avgAsc: (a, b) => avg(a) - avg(b),
  // Sin movimientos (sin nivel) quedan al final en "recientes primero".
  movedDesc: (a, b) => (time(b) === time(a) ? 0 : time(b) > time(a) ? 1 : -1),
  movedAsc: (a, b) => (time(a) === time(b) ? 0 : time(a) > time(b) ? 1 : -1),
};

/** Orden estable: empate → por nombre. No muta la entrada. */
export function sortStockRows(rows: StockRowView[], sort: StockSort): StockRowView[] {
  const cmp = COMPARE[sort] ?? COMPARE.name;
  return [...rows].sort((a, b) => cmp(a, b) || byName(a, b));
}

/** Columna y dirección activas de un orden (para aria-sort y la flecha). */
export function sortDirection(sort: StockSort, column: StockSortColumn): "asc" | "desc" | null {
  const map: Record<StockSortColumn, [StockSort, StockSort]> = {
    name: ["name", "nameDesc"],
    qty: ["qtyAsc", "qtyDesc"],
    avg: ["avgAsc", "avgDesc"],
    value: ["valueAsc", "valueDesc"],
    moved: ["movedAsc", "movedDesc"],
  };
  const [asc, desc] = map[column];
  return sort === asc ? "asc" : sort === desc ? "desc" : null;
}

/**
 * Click en un encabezado: si la columna ya está activa invierte la
 * dirección; si no, arranca en su dirección natural (A→Z para el nombre,
 * mayor primero para cantidades y plata, más reciente primero para fechas).
 */
export function toggleSort(sort: StockSort, column: StockSortColumn): StockSort {
  const dir = sortDirection(sort, column);
  switch (column) {
    case "name": return dir === "asc" ? "nameDesc" : "name";
    case "qty": return dir === "desc" ? "qtyAsc" : "qtyDesc";
    case "avg": return dir === "desc" ? "avgAsc" : "avgDesc";
    case "value": return dir === "desc" ? "valueAsc" : "valueDesc";
    case "moved": return dir === "desc" ? "movedAsc" : "movedDesc";
  }
}

export type StockSummary = { items: number; valueCents: number; lowCount: number };

/** Tira de resumen: SIEMPRE sobre todo el conjunto filtrado, no la página. */
export function summarizeStock(rows: StockRowView[]): StockSummary {
  let valueCents = 0;
  let lowCount = 0;
  for (const r of rows) {
    valueCents += value(r);
    if (isLowStock(r)) lowCount++;
  }
  return { items: rows.length, valueCents, lowCount };
}

export type StockChipCounts = { low: number; stocked: number; archived: number };

/**
 * Cuántos insumos mostraría cada chip si se activara, respetando la
 * búsqueda y la categoría (y la visibilidad de archivados para los dos
 * primeros). Los chips no se cuentan entre sí: el número dice qué hay
 * detrás de cada uno, no la intersección con los otros chips activos.
 */
export function stockChipCounts(rows: StockRowView[], f: Pick<StockFilters, "q" | "category" | "showArchived">): StockChipCounts {
  const needle = fold(f.q.trim());
  const counts: StockChipCounts = { low: 0, stocked: 0, archived: 0 };
  for (const r of rows) {
    if (!matchesScope(r, needle, f.category)) continue;
    if (!r.active) counts.archived++;
    if (!f.showArchived && !r.active) continue;
    if (isLowStock(r)) counts.low++;
    if (qty(r) !== 0) counts.stocked++;
  }
  return counts;
}

/** Categorías presentes (A→Z) para el filtro. */
export function stockCategories(rows: StockRowView[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.category) set.add(r.category);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export const STOCK_PAGE_SIZE = 50;

export type Page<T> = {
  items: T[];
  /** 1-based, ya acotada al rango válido. */
  page: number;
  pageCount: number;
  /** Posiciones 1-based para "Mostrando X–Y de N" (0–0 si no hay filas). */
  from: number;
  to: number;
  total: number;
};

/** Paginación cliente: nunca recorta en silencio, siempre informa el total. */
export function paginate<T>(items: T[], page: number, pageSize = STOCK_PAGE_SIZE): Page<T> {
  const total = items.length;
  const size = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    page: current,
    pageCount,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
    total,
  };
}

/** Después de archivar: con saldo sigue en la lista; en cero ya no aplica. */
export function applyArchive(rows: StockRowView[], id: string, active: boolean): StockRowView[] {
  return rows.flatMap((r) => {
    if (r.id !== id) return [r];
    if (!active && qty(r) === 0) return [];
    return [{ ...r, active }];
  });
}
