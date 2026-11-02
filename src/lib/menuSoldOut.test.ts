import { describe, expect, it } from "vitest";
import {
  daysSince,
  groupSoldOutByCategory,
  toSoldOutItems,
  type SoldOutRow,
} from "./menuSoldOut";

/**
 * Aviso de platos agotados al abrir el turno: la lista sale ordenada como la
 * carta y agrupada por categoría, con las subcategorías rotuladas con su
 * padre.
 */

const row = (
  id: string,
  name: string,
  category: SoldOutRow["category"],
  sortOrder = 0,
  updatedAt = new Date("2026-11-01T15:00:00Z"),
): SoldOutRow => ({ id, name, sortOrder, updatedAt, category });

const entradas = { label: "Entradas", sortOrder: 10, parent: null };
const fuertes = { label: "Fuertes", sortOrder: 20, parent: null };
const vinos = { label: "Vinos", sortOrder: 30, parent: null };
const malbec = { label: "Malbec", sortOrder: 5, parent: { label: "Vinos", sortOrder: 30 } };

describe("toSoldOutItems", () => {
  it("ordena por categoría, subcategoría y plato, y rotula la subcategoría con su padre", () => {
    const items = toSoldOutItems([
      row("m1", "Catena", malbec, 1),
      row("f2", "Bandeja", fuertes, 20),
      row("v1", "Rosado de la casa", vinos, 1),
      row("e1", "Ceviche", entradas, 5),
      row("f1", "Ajiaco", fuertes, 10),
    ]);
    expect(items.map((i) => i.id)).toEqual(["e1", "f1", "f2", "v1", "m1"]);
    expect(items.map((i) => i.categoryName)).toEqual([
      "Entradas",
      "Fuertes",
      "Fuertes",
      "Vinos",
      "Vinos › Malbec",
    ]);
  });

  it("desempata por nombre y expone la última edición como soldOutSince", () => {
    const items = toSoldOutItems([
      row("b", "Sopa", entradas, 0, new Date("2026-10-30T10:00:00Z")),
      row("a", "Arepa", entradas, 0, new Date("2026-10-31T10:00:00Z")),
    ]);
    expect(items.map((i) => i.name)).toEqual(["Arepa", "Sopa"]);
    expect(items[0]).toEqual({
      id: "a",
      name: "Arepa",
      categoryName: "Entradas",
      soldOutSince: "2026-10-31T10:00:00.000Z",
    });
  });
});

describe("groupSoldOutByCategory", () => {
  it("agrupa conservando el orden de llegada", () => {
    const groups = groupSoldOutByCategory(
      toSoldOutItems([
        row("f1", "Ajiaco", fuertes, 10),
        row("e1", "Ceviche", entradas, 5),
        row("f2", "Bandeja", fuertes, 20),
      ]),
    );
    expect(groups.map((g) => g.categoryName)).toEqual(["Entradas", "Fuertes"]);
    expect(groups[1].items.map((i) => i.name)).toEqual(["Ajiaco", "Bandeja"]);
  });

  it("con lista vacía no arma grupos", () => {
    expect(groupSoldOutByCategory([])).toEqual([]);
  });
});

describe("daysSince", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  it("cuenta días enteros y nunca da negativo", () => {
    expect(daysSince("2026-11-02T08:00:00Z", now)).toBe(0);
    expect(daysSince("2026-11-01T11:00:00Z", now)).toBe(1);
    expect(daysSince("2026-10-20T12:00:00Z", now)).toBe(13);
    expect(daysSince("2026-11-03T12:00:00Z", now)).toBe(0);
    expect(daysSince("no-es-fecha", now)).toBe(0);
  });
});
