import { describe, it, expect } from "vitest";
import { aggregateTopDishes, type DishRow } from "./topDishes";

const rows: DishRow[] = [
  { name: "Taco", qty: 3, priceCents: 1000 },
  { name: "Taco", qty: 2, priceCents: 1000 },
  { name: "Agua", qty: 10, priceCents: 200 },
  { name: "Pizza", qty: 1, priceCents: 5000 },
];

describe("aggregateTopDishes", () => {
  it("ordena por cantidad y suma por nombre", () => {
    const out = aggregateTopDishes(rows, { by: "qty", limit: 2 });
    expect(out.map((d) => d.name)).toEqual(["Agua", "Taco"]);
    expect(out[0]).toMatchObject({ name: "Agua", qty: 10, revenueCents: 2000 });
    expect(out[1]).toMatchObject({ name: "Taco", qty: 5, revenueCents: 5000 });
  });
  it("ordena por ingreso", () => {
    const out = aggregateTopDishes(rows, { by: "revenue", limit: 1 });
    expect(out[0].name).toBe("Pizza"); // 5000
  });
});
