import { describe, expect, it } from "vitest";
import {
  habitualHistoryItems,
  summarizeSupplierHistory,
  type SupplierHistoryOrder,
  type SupplierHistoryOrderLine,
} from "./supplierHistory";

const line = (ingredientId: string, p: Partial<SupplierHistoryOrderLine> = {}): SupplierHistoryOrderLine => ({
  ingredientId,
  supplierItemId: null,
  presentations: null,
  qtyOrderedBase: 1000,
  listCostCents: null,
  expectedCostCents: 100_000,
  taxPct: 0,
  expectedIncCents: 0,
  ingredient: { active: true },
  ...p,
});

const orders: SupplierHistoryOrder[] = [
  // La más vieja primero a propósito: el resumen ordena por fecha.
  { createdAt: "2026-10-01T12:00:00Z", items: [line("rice", { qtyOrderedBase: 9000, expectedCostCents: 1 }), line("oil")] },
  {
    createdAt: "2026-10-20T12:00:00Z",
    items: [
      line("rice", { qtyOrderedBase: 25_000, listCostCents: 12_500_000, expectedCostCents: 11_250_000, taxPct: 5 }),
      line("rice", { qtyOrderedBase: 1 }),
      line("beef", { supplierItemId: "si", presentations: 2, qtyOrderedBase: 100_000, expectedCostCents: 1_000_000, expectedIncCents: 80_000 }),
      line("gone", { ingredient: { active: false } }),
    ],
  },
  { createdAt: new Date("2026-10-10T12:00:00Z"), items: [line("rice"), line("oil", { taxPct: 19 })] },
];

describe("lo que se le pide a un proveedor", () => {
  const h = summarizeSupplierHistory(orders);

  it("cuenta cada orden una vez por insumo y ordena por lo más pedido", () => {
    expect(h.orderCount).toBe(3);
    expect(h.items.map((i) => [i.ingredientId, i.orders])).toEqual([
      ["rice", 3],
      ["oil", 2],
      ["beef", 1],
    ]);
  });

  it("recuerda la última línea: precio de lista, cantidad, presentación, IVA y consumo", () => {
    expect(h.items[0]).toMatchObject({
      lastOrderedAt: "2026-10-20T12:00:00.000Z",
      qtyBase: 25_000,
      listCostCents: 12_500_000,
      taxPct: 5,
      incPct: null,
      supplierItemId: null,
      presentations: null,
    });
    expect(h.items[1]).toMatchObject({ lastOrderedAt: "2026-10-10T12:00:00.000Z", taxPct: 19, listCostCents: 100_000 });
    expect(h.items[2]).toMatchObject({ supplierItemId: "si", presentations: 2, incPct: 8 });
  });

  it("no incluye insumos inactivos y respeta el límite", () => {
    expect(h.items.some((i) => i.ingredientId === "gone")).toBe(false);
    expect(summarizeSupplierHistory(orders, { limit: 1 }).items).toHaveLength(1);
    expect(summarizeSupplierHistory([])).toEqual({ orderCount: 0, items: [] });
  });

  it("habituales: lo que se repite; si nada se repite, lo de la última orden", () => {
    expect(habitualHistoryItems(h).map((i) => i.ingredientId)).toEqual(["rice", "oil"]);
    const once = summarizeSupplierHistory([orders[1]!]);
    expect(habitualHistoryItems(once).map((i) => i.ingredientId)).toEqual(["rice", "beef"]);
    expect(habitualHistoryItems({ orderCount: 0, items: [] })).toEqual([]);
  });
});
