import { describe, expect, it } from "vitest";
import {
  fuzzyNormalize,
  matchesQuery,
  searchMenuItems,
  searchTokens,
} from "./menuSearch";

/** Azúcar: buscar `query` dentro de `text`, como lo hace la carta. */
const finds = (text: string, query: string) =>
  matchesQuery(text, searchTokens(query));

describe("palabras sueltas (el caso que motivó el cambio)", () => {
  it("'solomito res' encuentra 'Solomito de res'", () => {
    expect(finds("Solomito de res", "solomito res")).toBe(true);
  });

  it("no importa el orden: 'res solomito' también", () => {
    expect(finds("Solomito de res", "res solomito")).toBe(true);
  });

  it("basta con parte de cada palabra", () => {
    expect(finds("Solomito de res a la parrilla", "solo parri")).toBe(true);
  });

  it("si falta una palabra, no matchea", () => {
    expect(finds("Solomito de res", "solomito cerdo")).toBe(false);
  });

  it("las palabras pueden venir del nombre Y de la descripción", () => {
    expect(finds("Solomito de res — madurado 21 días", "solomito madurado")).toBe(
      true,
    );
  });
});

describe("no se pierde lo que ya funcionaba", () => {
  it("una sola palabra sigue matcheando por subcadena", () => {
    expect(finds("Hamburguesa doble", "burguesa")).toBe(true);
  });

  it("la frase entera y contigua sigue matcheando", () => {
    expect(finds("Solomito de res", "solomito de res")).toBe(true);
  });

  it("consulta vacía no filtra nada", () => {
    expect(finds("lo que sea", "")).toBe(true);
    expect(finds("lo que sea", "   ")).toBe(true);
  });
});

describe("normalización tolerante", () => {
  it("ignora acentos y ñ", () => {
    expect(finds("Limón", "limon")).toBe(true);
    expect(finds("Piña colada", "pina")).toBe(true);
  });

  it("ignora puntuación", () => {
    expect(finds("Sangría, espumosa", "sangria espumosa")).toBe(true);
  });

  it("perdona confusiones ortográficas del español", () => {
    expect(finds("Pescado al ajillo", "pezcado")).toBe(true);
    expect(finds("Vaca vieja", "baka")).toBe(true);
    expect(finds("Huevos pericos", "uevos")).toBe(true);
    expect(finds("Quesillo", "kesillo")).toBe(true);
  });

  it("es simétrica: la misma transformación sobre los dos lados", () => {
    expect(fuzzyNormalize("Vaca")).toBe(fuzzyNormalize("baka"));
  });
});

describe("searchTokens", () => {
  it("parte en palabras y normaliza", () => {
    expect(searchTokens("  Solomito   de RES ")).toEqual([
      "solomito",
      "de",
      "res",
    ]);
  });

  it("una consulta sin letras ni números no deja palabras", () => {
    expect(searchTokens("!!! ---")).toEqual([]);
  });
});

/*
 * Búsqueda global: una carta con dos pestañas (Carta y Vinos), categorías
 * anidadas (Tintos → Malbec) y platos repartidos. Es el escenario donde la
 * búsqueda "por pestaña" fallaba.
 */
const menus = [
  { id: "m-carta", label: "Carta" },
  { id: "m-vinos", label: "Vinos" },
];
const categories = [
  { id: "c-entradas", slug: "entradas", label: "Entradas", menuId: "m-carta", parentId: null },
  { id: "c-fuertes", slug: "fuertes", label: "Fuertes", menuId: "m-carta", parentId: null },
  { id: "c-postres", slug: "postres", label: "Postres", menuId: "m-carta", parentId: null },
  { id: "c-tintos", slug: "tintos", label: "Tintos", menuId: "m-vinos", parentId: null },
  { id: "c-malbec", slug: "malbec", label: "Malbec", menuId: "m-vinos", parentId: "c-tintos" },
  { id: "c-blancos", slug: "blancos", label: "Blancos", menuId: "m-vinos", parentId: null },
];
const items = [
  { id: "i-1", categoryId: "c-entradas", name: "Carpaccio de res", description: "Con parmesano" },
  { id: "i-2", categoryId: "c-fuertes", name: "Solomito de res", description: "Madurado 21 días" },
  { id: "i-3", categoryId: "c-fuertes", name: "Pescado al ajillo", description: "" },
  { id: "i-4", categoryId: "c-postres", name: "Tiramisú", description: "Clásico" },
  { id: "i-5", categoryId: "c-malbec", name: "Catena Malbec", description: "Mendoza" },
  { id: "i-6", categoryId: "c-blancos", name: "Sauvignon Blanc", description: "Fresco, de res… no: de uva" },
];

/**
 * Lo que hacía el componente antes del arreglo: sólo tenían "cubeta" las
 * categorías de la pestaña activa; un plato de otra pestaña se descartaba.
 */
function legacyScopedSearch(activeMenuId: string, query: string) {
  const tokens = searchTokens(query);
  const scoped = categories.filter((c) => c.menuId === activeMenuId);
  const map = new Map<string, typeof items>();
  for (const c of scoped) map.set(c.id, []);
  for (const it of items) {
    if (!matchesQuery(`${it.name} ${it.description ?? ""}`, tokens)) continue;
    map.get(it.categoryId)?.push(it);
  }
  return Array.from(map.values()).flat();
}

describe("searchMenuItems — recorre toda la carta", () => {
  it("reproduce el problema: parado en Carta, 'malbec' no aparecía", () => {
    // Antes: nada, aunque el vino existe en la pestaña Vinos.
    expect(legacyScopedSearch("m-carta", "malbec")).toEqual([]);
    // Ahora: aparece, y dice de qué categoría y pestaña viene.
    const groups = searchMenuItems(items, "malbec", { categories, menus });
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["i-5"]);
    expect(groups[0].category.label).toBe("Malbec");
    expect(groups[0].parent?.label).toBe("Tintos");
    expect(groups[0].menu?.label).toBe("Vinos");
  });

  it("ignora cualquier categoría o pestaña 'activa': no hay parámetro para eso", () => {
    // Un plato de Fuertes se encuentra igual que uno de Postres o de Vinos.
    const ids = searchMenuItems(items, "res", { categories, menus })
      .flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toEqual(expect.arrayContaining(["i-1", "i-2", "i-6"]));
  });

  it("agrupa por categoría en el orden de la carta (pestaña → categoría → subcategoría → plato)", () => {
    const groups = searchMenuItems(items, "a", { categories, menus });
    expect(groups.map((g) => g.category.slug)).toEqual([
      "entradas",
      "fuertes",
      "postres",
      "malbec",
      "blancos",
    ]);
    // Dentro de Fuertes se respeta el orden de la carta.
    const fuertes = groups.find((g) => g.category.slug === "fuertes");
    expect(fuertes?.items.map((i) => i.id)).toEqual(["i-2", "i-3"]);
  });

  it("sin pestañas, ordena por jerarquía de categorías y menu queda null", () => {
    const groups = searchMenuItems(items, "a", { categories });
    // "Tintos" no tiene platos directos (viven en Malbec), así que no sale.
    expect(groups.map((g) => g.category.slug)).toEqual([
      "entradas",
      "fuertes",
      "postres",
      "malbec",
      "blancos",
    ]);
    expect(groups.every((g) => g.menu === null)).toBe(true);
  });

  it("busca en nombre y descripción con todas las palabras", () => {
    const groups = searchMenuItems(items, "solomito madurado", { categories, menus });
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toEqual(["i-2"]);
  });

  it("consulta vacía o sin letras ni números ⇒ sin búsqueda activa", () => {
    expect(searchMenuItems(items, "", { categories, menus })).toEqual([]);
    expect(searchMenuItems(items, "   ", { categories, menus })).toEqual([]);
    expect(searchMenuItems(items, "!!!", { categories, menus })).toEqual([]);
  });

  it("sin coincidencias ⇒ lista vacía (el UI muestra 'sin resultados')", () => {
    expect(searchMenuItems(items, "sushi", { categories, menus })).toEqual([]);
  });

  it("omite un ítem cuya categoría no existe: no habría dónde mostrarlo", () => {
    const orphan = { id: "i-x", categoryId: "c-nope", name: "Fantasma", description: "" };
    const groups = searchMenuItems([...items, orphan], "fantasma", { categories, menus });
    expect(groups).toEqual([]);
  });
});
