import { describe, expect, it } from "vitest";
import {
  applyArchive,
  DEFAULT_STOCK_FILTERS,
  filterStockRows,
  isLowStock,
  paginate,
  reorderState,
  sortDirection,
  sortStockRows,
  stockCategories,
  stockChipCounts,
  summarizeStock,
  toggleSort,
  unitCost,
  type StockRowView,
} from "./inventoryView";

function row(over: Partial<StockRowView> & { id: string }): StockRowView {
  return {
    name: over.id,
    category: null,
    measureKind: "mass",
    active: true,
    barcode: null,
    barcodes: [],
    reorderPointBase: null,
    reorderQtyBase: null,
    stockLevel: null,
    ...over,
  };
}
const level = (qtyBase: number, totalValueCents: number, updatedAt = "2026-11-01T12:00:00Z") => ({ qtyBase, totalValueCents, updatedAt });

const rice = row({ id: "rice", name: "Arroz", category: "Abarrotes", stockLevel: level(6000, 270_000, "2026-11-03T10:00:00Z"), barcode: "770100", barcodes: [{ barcode: "770100" }, { barcode: "ALT-9" }] });
const basil = row({ id: "basil", name: "Albahaca", category: "Verduras", reorderPointBase: 3000, stockLevel: level(2845, 569_000, "2026-11-02T10:00:00Z") });
const truffle = row({ id: "truffle", name: "Aceite de trufa", category: "Abarrotes", measureKind: "volume", reorderPointBase: 500, stockLevel: level(-1275, 0) });
const salt = row({ id: "salt", name: "Sal", category: "Abarrotes" }); // sin movimientos
const gin = row({ id: "gin", name: "Gin", category: "Licores", measureKind: "volume", reorderPointBase: 1000, stockLevel: level(3240, 4_536_000) });
const oldCheese = row({ id: "cheese", name: "Queso viejo", category: "Lácteos", active: false, reorderPointBase: 99_999, stockLevel: level(1500, 90_000) });
const rows = [truffle, basil, rice, gin, salt, oldCheese];

describe("estado bajo mínimo", () => {
  it("marca existencia ≤ punto de reorden, negativos incluidos, y sin nivel cuenta como cero", () => {
    expect(isLowStock(basil)).toBe(true);
    expect(isLowStock(truffle)).toBe(true);
    expect(isLowStock(row({ id: "x", reorderPointBase: 0 }))).toBe(true);
    expect(isLowStock(gin)).toBe(false);
    expect(isLowStock(rice)).toBe(false);
  });
  it("nunca alerta archivados ni insumos sin punto", () => {
    expect(isLowStock(oldCheese)).toBe(false);
    expect(reorderState(oldCheese)).toBe("none");
    expect(reorderState(rice)).toBe("none");
    expect(reorderState(gin)).toBe("ok");
    expect(reorderState(basil)).toBe("low");
  });
});

describe("costo unitario", () => {
  it("usa la unidad de display de la existencia y no inventa promedio sin saldo positivo", () => {
    expect(unitCost(rice)).toEqual({ cents: 45_000, symbol: "kg" });
    expect(unitCost(basil)).toEqual({ cents: 200_000, symbol: "kg" });
    expect(unitCost(truffle)).toBeNull();
    expect(unitCost(salt)).toBeNull();
  });
});

describe("filtros", () => {
  it("esconde archivados salvo que se pidan y busca sin tildes por nombre, categoría y código", () => {
    expect(filterStockRows(rows, DEFAULT_STOCK_FILTERS, "name").map((r) => r.id)).toEqual(["truffle", "basil", "rice", "gin", "salt"]);
    expect(filterStockRows(rows, { ...DEFAULT_STOCK_FILTERS, showArchived: true }, "name").map((r) => r.id)).toEqual(["truffle", "basil", "rice", "gin", "cheese", "salt"]);
    expect(filterStockRows(rows, { ...DEFAULT_STOCK_FILTERS, q: "ALBAHACA" }, "name").map((r) => r.id)).toEqual(["basil"]);
    expect(filterStockRows(rows, { ...DEFAULT_STOCK_FILTERS, q: "lacteos", showArchived: true }, "name").map((r) => r.id)).toEqual(["cheese"]);
    expect(filterStockRows(rows, { ...DEFAULT_STOCK_FILTERS, q: "alt-9" }, "name").map((r) => r.id)).toEqual(["rice"]);
  });
  it("combina categoría, bajo mínimo y con existencias", () => {
    const f = { ...DEFAULT_STOCK_FILTERS, category: "Abarrotes" };
    expect(filterStockRows(rows, f, "name").map((r) => r.id)).toEqual(["truffle", "rice", "salt"]);
    expect(filterStockRows(rows, { ...f, lowOnly: true }, "name").map((r) => r.id)).toEqual(["truffle"]);
    expect(filterStockRows(rows, { ...f, stockedOnly: true }, "name").map((r) => r.id)).toEqual(["truffle", "rice"]);
  });
});

describe("orden", () => {
  it("ordena por cada columna con desempate por nombre y sin mutar la entrada", () => {
    const input = [...rows];
    expect(sortStockRows(input, "qtyDesc").map((r) => r.id)).toEqual(["rice", "gin", "basil", "cheese", "salt", "truffle"]);
    expect(sortStockRows(input, "valueDesc")[0].id).toBe("gin");
    expect(sortStockRows(input, "avgAsc").slice(0, 2).map((r) => r.id)).toEqual(["truffle", "salt"]);
    expect(sortStockRows(input, "movedDesc").map((r) => r.id)).toEqual(["rice", "basil", "truffle", "gin", "cheese", "salt"]);
    expect(sortStockRows(input, "nameDesc").map((r) => r.id)).toEqual(["salt", "cheese", "gin", "rice", "basil", "truffle"]);
    expect(input).toEqual(rows);
  });
  it("el encabezado alterna la dirección de su columna y arranca en la natural", () => {
    expect(toggleSort("name", "name")).toBe("nameDesc");
    expect(toggleSort("nameDesc", "name")).toBe("name");
    expect(toggleSort("name", "value")).toBe("valueDesc");
    expect(toggleSort("valueDesc", "value")).toBe("valueAsc");
    expect(toggleSort("valueAsc", "value")).toBe("valueDesc");
    expect(toggleSort("qtyAsc", "moved")).toBe("movedDesc");
    expect(sortDirection("avgAsc", "avg")).toBe("asc");
    expect(sortDirection("avgAsc", "qty")).toBeNull();
  });
});

describe("resumen y chips", () => {
  it("resume TODO el conjunto filtrado, no la página visible", () => {
    const filtered = filterStockRows(rows, DEFAULT_STOCK_FILTERS, "name");
    expect(summarizeStock(filtered)).toEqual({ items: 5, valueCents: 0 + 569_000 + 270_000 + 4_536_000, lowCount: 2 });
    const many = Array.from({ length: 120 }, (_, i) => row({ id: `i${i}`, stockLevel: level(10, 100), reorderPointBase: i < 7 ? 50 : null }));
    const page = paginate(many, 1);
    expect(page.items).toHaveLength(50);
    expect(summarizeStock(many)).toEqual({ items: 120, valueCents: 12_000, lowCount: 7 });
  });
  it("cuenta cada chip respetando búsqueda y categoría", () => {
    expect(stockChipCounts(rows, { q: "", category: "all", showArchived: false })).toEqual({ low: 2, stocked: 4, archived: 1 });
    expect(stockChipCounts(rows, { q: "", category: "all", showArchived: true })).toEqual({ low: 2, stocked: 5, archived: 1 });
    expect(stockChipCounts(rows, { q: "", category: "Abarrotes", showArchived: false })).toEqual({ low: 1, stocked: 2, archived: 0 });
    expect(stockChipCounts(rows, { q: "queso", category: "all", showArchived: false })).toEqual({ low: 0, stocked: 0, archived: 1 });
  });
  it("lista las categorías presentes en orden", () => {
    expect(stockCategories(rows)).toEqual(["Abarrotes", "Lácteos", "Licores", "Verduras"]);
  });
});

describe("paginación", () => {
  const items = Array.from({ length: 123 }, (_, i) => i);
  it("informa el rango y el total", () => {
    expect(paginate(items, 1)).toMatchObject({ page: 1, pageCount: 3, from: 1, to: 50, total: 123 });
    expect(paginate(items, 3)).toMatchObject({ page: 3, from: 101, to: 123 });
    expect(paginate(items, 3).items).toHaveLength(23);
  });
  it("acota páginas fuera de rango y maneja la lista vacía", () => {
    expect(paginate(items, 99).page).toBe(3);
    expect(paginate(items, 0).page).toBe(1);
    expect(paginate([], 4)).toMatchObject({ items: [], page: 1, pageCount: 1, from: 0, to: 0, total: 0 });
    expect(paginate(items, 2, 100)).toMatchObject({ from: 101, to: 123, pageCount: 2 });
  });
});

describe("archivar desde inventario", () => {
  it("conserva el insumo con saldo como archivado y saca el que quedó en cero", () => {
    expect(applyArchive(rows, "rice", false).find((r) => r.id === "rice")?.active).toBe(false);
    expect(applyArchive(rows, "salt", false).some((r) => r.id === "salt")).toBe(false);
    expect(applyArchive(rows, "cheese", true).find((r) => r.id === "cheese")?.active).toBe(true);
  });
});
