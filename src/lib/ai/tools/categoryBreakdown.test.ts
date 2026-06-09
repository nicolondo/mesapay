import { describe, it, expect } from "vitest";
import { aggregateCategories, type CatRow } from "./categoryBreakdown";

const rows: CatRow[] = [
  { category: "Pizzas", kind: "main", qty: 2, priceCents: 10000 },
  { category: "Pizzas", kind: "main", qty: 1, priceCents: 12000 },
  { category: "Vinos", kind: "drink", qty: 3, priceCents: 8000 },
];

describe("aggregateCategories", () => {
  it("suma ingreso y qty por categoría, ordena por ingreso", () => {
    const r = aggregateCategories(rows, { limit: 10 });
    expect(r.categories[0]).toEqual({ category: "Pizzas", kind: "main", qty: 3, revenueCents: 32000 });
    expect(r.byKind).toContainEqual({ kind: "drink", revenueCents: 24000 });
    expect(r.totalRevenueCents).toBe(56000);
  });
});
