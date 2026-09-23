import { describe, expect, it } from "vitest";
import {
  DEFAULT_MENU_ITEM_ORDER,
  isMenuItemOrder,
  moveItem,
  moveToSlot,
  normalizeMenuItemOrder,
  positionsFor,
  sortMenuItems,
  stepItem,
} from "./menuOrder";
import { searchMenuItems } from "./menuSearch";

type Row = { id: string; name: string; sortOrder: number };
const row = (id: string, name: string, sortOrder = 0): Row => ({ id, name, sortOrder });
const names = (rows: { name: string }[]) => rows.map((r) => r.name);
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("modo de orden", () => {
  it("el default es alfabético (lo pidió el dueño)", () => {
    expect(DEFAULT_MENU_ITEM_ORDER).toBe("alphabetical");
  });

  it("sólo acepta los dos modos conocidos", () => {
    expect(isMenuItemOrder("alphabetical")).toBe(true);
    expect(isMenuItemOrder("manual")).toBe(true);
    expect(isMenuItemOrder("Manual")).toBe(false);
    expect(isMenuItemOrder("")).toBe(false);
    expect(isMenuItemOrder(null)).toBe(false);
  });

  it("un valor raro de la base cae al default en vez de romper la carta", () => {
    expect(normalizeMenuItemOrder("manual")).toBe("manual");
    expect(normalizeMenuItemOrder("price")).toBe("alphabetical");
    expect(normalizeMenuItemOrder(undefined)).toBe("alphabetical");
  });
});

describe("sortMenuItems — alfabético", () => {
  it("ordena por nombre ignorando la posición del editor", () => {
    const rows = [row("1", "Tiramisú", 10), row("2", "Brownie", 20), row("3", "Flan", 30)];
    expect(names(sortMenuItems(rows, "alphabetical", "es"))).toEqual([
      "Brownie",
      "Flan",
      "Tiramisú",
    ]);
  });

  it("no le importan las tildes: 'Ají' queda junto a 'Aji', no al final", () => {
    const rows = [row("1", "Arepa"), row("2", "Ají de gallina"), row("3", "Zumo"), row("4", "Aji picante")];
    expect(names(sortMenuItems(rows, "alphabetical", "es"))).toEqual([
      "Ají de gallina",
      "Aji picante",
      "Arepa",
      "Zumo",
    ]);
  });

  it("no le importan las mayúsculas", () => {
    const rows = [row("1", "limonada"), row("2", "Agua"), row("3", "CERVEZA")];
    expect(names(sortMenuItems(rows, "alphabetical", "es"))).toEqual([
      "Agua",
      "CERVEZA",
      "limonada",
    ]);
  });

  it("es natural con los números: 'Combo 2' antes de 'Combo 10'", () => {
    const rows = [row("1", "Combo 10"), row("2", "Combo 2"), row("3", "Combo 1")];
    expect(names(sortMenuItems(rows, "alphabetical", "es"))).toEqual([
      "Combo 1",
      "Combo 2",
      "Combo 10",
    ]);
  });

  it("la ñ va después de la n en español", () => {
    const rows = [row("1", "Ñame frito"), row("2", "Nachos"), row("3", "Ostras")];
    expect(names(sortMenuItems(rows, "alphabetical", "es"))).toEqual([
      "Nachos",
      "Ñame frito",
      "Ostras",
    ]);
  });

  it("los signos del principio no mandan al plato al comienzo de la lista", () => {
    const rows = [row("1", "¡Picada!"), row("2", "Arroz"), row("3", "\"Especial\" de la casa"), row("4", "Tacos")];
    expect(names(sortMenuItems(rows, "alphabetical", "es"))).toEqual([
      "Arroz",
      "\"Especial\" de la casa",
      "¡Picada!",
      "Tacos",
    ]);
  });

  it("es estable: dos nombres iguales salvo tildes/mayúsculas conservan el orden de entrada", () => {
    const rows = [row("b", "Cafe", 20), row("x", "Agua", 0), row("a", "café", 10), row("c", "CAFÉ", 30)];
    expect(ids(sortMenuItems(rows, "alphabetical", "es"))).toEqual(["x", "b", "a", "c"]);
  });

  it("ordena por el nombre que se muestra (la traducción) en el idioma del comensal", () => {
    // Mismos platos, nombres traducidos al inglés: el orden cambia.
    const rows = [row("1", "Chicken soup"), row("2", "Beef stew"), row("3", "Apple pie")];
    expect(ids(sortMenuItems(rows, "alphabetical", "en"))).toEqual(["3", "2", "1"]);
  });

  it("no toca la lista original", () => {
    const rows = [row("1", "B"), row("2", "A")];
    sortMenuItems(rows, "alphabetical", "es");
    expect(names(rows)).toEqual(["B", "A"]);
  });
});

describe("sortMenuItems — manual", () => {
  it("respeta la posición del editor, no el nombre", () => {
    const rows = [row("1", "Arepa", 30), row("2", "Zumo", 10), row("3", "Mote", 20)];
    expect(names(sortMenuItems(rows, "manual", "es"))).toEqual(["Zumo", "Mote", "Arepa"]);
  });

  it("empates de posición conservan el orden de entrada", () => {
    const rows = [row("a", "Zeta", 10), row("b", "Alfa", 10), row("c", "Beta", 0)];
    expect(ids(sortMenuItems(rows, "manual", "es"))).toEqual(["c", "a", "b"]);
  });
});

describe("reordenamiento manual", () => {
  const list = ["a", "b", "c", "d"];

  it("subir y bajar corren el plato un lugar", () => {
    expect(stepItem(list, 2, "up")).toEqual(["a", "c", "b", "d"]);
    expect(stepItem(list, 1, "down")).toEqual(["a", "c", "b", "d"]);
  });

  it("subir el primero o bajar el último no cambia nada", () => {
    expect(stepItem(list, 0, "up")).toEqual(list);
    expect(stepItem(list, 3, "down")).toEqual(list);
  });

  it("moveItem lleva el elemento al índice final pedido", () => {
    expect(moveItem(list, 0, 3)).toEqual(["b", "c", "d", "a"]);
    expect(moveItem(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveItem(list, 1, 99)).toEqual(["a", "c", "d", "b"]);
    expect(moveItem(list, 9, 0)).toEqual(list);
  });

  it("soltar en un hueco: antes del primero, en el medio y al final", () => {
    expect(moveToSlot(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveToSlot(list, 0, 2)).toEqual(["b", "a", "c", "d"]);
    expect(moveToSlot(list, 0, 4)).toEqual(["b", "c", "d", "a"]);
    expect(moveToSlot(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  it("soltar en su propio hueco o en el de al lado no cambia nada", () => {
    expect(moveToSlot(list, 1, 1)).toEqual(list);
    expect(moveToSlot(list, 1, 2)).toEqual(list);
  });

  it("las posiciones nuevas dejan huecos de 10, como el alta de un plato", () => {
    expect([...positionsFor(["c", "a", "b"])]).toEqual([
      ["c", 10],
      ["a", 20],
      ["b", 30],
    ]);
  });
});

describe("búsqueda global con el mismo orden", () => {
  // La carta del comensal recibe los platos YA ordenados (page.tsx) y la
  // búsqueda conserva ese orden dentro de cada grupo: la agrupación por
  // categoría no cambia, el orden de los platos de cada grupo sí.
  const categories = [
    { id: "postres", label: "Postres", menuId: "m1", parentId: null },
    { id: "entradas", label: "Entradas", menuId: "m1", parentId: null },
  ];
  const items = [
    { id: "t", categoryId: "postres", name: "Tiramisú de café", description: "", sortOrder: 10 },
    { id: "b", categoryId: "postres", name: "Brownie con café", description: "", sortOrder: 20 },
    { id: "s", categoryId: "entradas", name: "Sopa", description: "con café", sortOrder: 10 },
    { id: "a", categoryId: "entradas", name: "Arepa", description: "con café", sortOrder: 20 },
  ];
  const groupsFor = (mode: "alphabetical" | "manual") =>
    searchMenuItems(sortMenuItems(items, mode, "es"), "cafe", { categories }).map(
      (g) => [g.category.id, g.items.map((i) => i.id)],
    );

  it("alfabético: cada grupo en orden alfabético, los grupos en el orden de la carta", () => {
    expect(groupsFor("alphabetical")).toEqual([
      ["postres", ["b", "t"]],
      ["entradas", ["a", "s"]],
    ]);
  });

  it("manual: cada grupo por la posición del editor", () => {
    expect(groupsFor("manual")).toEqual([
      ["postres", ["t", "b"]],
      ["entradas", ["s", "a"]],
    ]);
  });
});
