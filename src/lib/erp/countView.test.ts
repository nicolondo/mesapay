import { describe, expect, it } from "vitest";
import {
  buildCountBarcodeIndex, canAppendScanOwner, classifyScanOwner, countOrderReducer, countRowState, countScopeCategory, countStats,
  EMPTY_COUNT_ORDER, filterCountItems, orderCountItems, pruneBlankCountParts, restoreCountOrder, serializeCountOrder, summarizeCountParts,
  type CountOrderAction, type CountOrderState,
} from "./countView";

const items = ["aceite", "burrata", "campari", "harina", "yuca"].map((id) => ({ id }));
const run = (...actions: CountOrderAction[]): CountOrderState => actions.reduce(countOrderReducer, EMPTY_COUNT_ORDER);
const ids = (state: CountOrderState) => {
  const { recent, rest } = orderCountItems(items, state.touched);
  return { recent: recent.map((item) => item.id), rest: rest.map((item) => item.id) };
};

describe("orden: lo último que se tocó, arriba", () => {
  it("sin tocar nada no hay grupo de recientes y el resto conserva su orden", () => {
    expect(ids(EMPTY_COUNT_ORDER)).toEqual({ recent: [], rest: ["aceite", "burrata", "campari", "harina", "yuca"] });
  });

  it("cada escaneo sube su insumo al primer lugar; los demás quedan abajo en su orden de siempre", () => {
    const state = run({ type: "scan", itemId: "harina" }, { type: "scan", itemId: "aceite" }, { type: "scan", itemId: "yuca" });
    expect(ids(state)).toEqual({ recent: ["yuca", "aceite", "harina"], rest: ["burrata", "campari"] });
  });

  it("volver a escanear un insumo ya contado lo regresa arriba sin duplicarlo", () => {
    const state = run({ type: "scan", itemId: "harina" }, { type: "scan", itemId: "aceite" }, { type: "scan", itemId: "harina" });
    expect(ids(state)).toEqual({ recent: ["harina", "aceite"], rest: ["burrata", "campari", "yuca"] });
  });

  it("teclear NO reordena: la fila se queda donde está hasta que se suelta", () => {
    const scanned = run({ type: "scan", itemId: "aceite" });
    const typing = [1, 2, 3].reduce((state) => countOrderReducer(state, { type: "edit", itemId: "campari" }), scanned);
    expect(typing.editing).toBe("campari");
    expect(ids(typing)).toEqual(ids(scanned));
    // Mismo objeto mientras se sigue escribiendo en la misma fila: nada se repinta.
    expect(countOrderReducer(typing, { type: "edit", itemId: "campari" })).toBe(typing);
    const released = countOrderReducer(typing, { type: "commit", itemId: "campari" });
    expect(released.editing).toBeNull();
    expect(ids(released)).toEqual({ recent: ["campari", "aceite"], rest: ["burrata", "harina", "yuca"] });
  });

  it("editar una fila que ya estaba en recientes tampoco la mueve hasta soltarla", () => {
    const state = run({ type: "scan", itemId: "aceite" }, { type: "scan", itemId: "yuca" }, { type: "edit", itemId: "aceite" });
    expect(ids(state).recent).toEqual(["yuca", "aceite"]);
    expect(ids(countOrderReducer(state, { type: "commit" })).recent).toEqual(["aceite", "yuca"]);
  });

  it("soltar una fila que no se editó (solo se enfocó) no cambia nada", () => {
    const state = run({ type: "scan", itemId: "aceite" });
    expect(countOrderReducer(state, { type: "commit", itemId: "burrata" })).toBe(state);
    expect(countOrderReducer(state, { type: "commit" })).toBe(state);
    // El blur de OTRA fila no se lleva la edición en curso.
    const typing = countOrderReducer(state, { type: "edit", itemId: "campari" });
    expect(countOrderReducer(typing, { type: "commit", itemId: "burrata" })).toBe(typing);
  });

  it("un escaneo con otra fila a medio editar asienta primero esa fila y deja la escaneada arriba", () => {
    const state = run({ type: "edit", itemId: "campari" }, { type: "scan", itemId: "yuca" });
    expect(state.editing).toBeNull();
    expect(ids(state).recent).toEqual(["yuca", "campari"]);
  });

  it("cambiar de fila sin soltar la anterior no pierde su turno", () => {
    const state = run({ type: "edit", itemId: "campari" }, { type: "edit", itemId: "burrata" });
    expect(state.editing).toBe("burrata");
    expect(ids(state).recent).toEqual(["campari"]);
  });

  it("al cambiar de etapa el orden vuelve a empezar", () => {
    const state = run({ type: "scan", itemId: "aceite" }, { type: "reset" });
    expect(state).toBe(EMPTY_COUNT_ORDER);
    expect(countOrderReducer(EMPTY_COUNT_ORDER, { type: "reset" })).toBe(EMPTY_COUNT_ORDER);
  });

  it("ignora ids que ya no están en el conteo", () => {
    expect(orderCountItems(items, { fantasma: 9, yuca: 1 }).recent.map((item) => item.id)).toEqual(["yuca"]);
  });
});

describe("orden guardado al guardar el borrador", () => {
  const saved = [
    { id: "aceite", countedQty: 1000 }, { id: "burrata", countedQty: null }, { id: "campari", countedQty: 0 }, { id: "yuca", countedQty: 5 },
  ];
  const state = run({ type: "scan", itemId: "aceite" }, { type: "scan", itemId: "burrata" }, { type: "scan", itemId: "campari" });

  it("se guarda de más reciente a más viejo y se reconstruye igual", () => {
    const stored = serializeCountOrder(state, "initial");
    expect(stored).toEqual({ phase: "initial", ids: ["campari", "burrata", "aceite"] });
    const restored = restoreCountOrder(JSON.parse(JSON.stringify(stored)), "initial", saved);
    // «burrata» se tocó pero quedó sin cantidad guardada: no vuelve a quedar arriba.
    expect(orderCountItems(saved, restored.touched).recent.map((item) => item.id)).toEqual(["campari", "aceite"]);
    // Lo siguiente que se toque queda encima de lo restaurado.
    const next = countOrderReducer(restored, { type: "scan", itemId: "yuca" });
    expect(orderCountItems(saved, next.touched).recent.map((item) => item.id)).toEqual(["yuca", "campari", "aceite"]);
  });

  it.each([
    ["otra etapa", { phase: "recount", ids: ["aceite"] }],
    ["vacío", null],
    ["corrupto", { phase: "initial", ids: "aceite" }],
    ["ids ajenos", { phase: "initial", ids: ["otro", 7, null] }],
  ])("descarta lo que no sirve: %s", (_label, stored) => {
    expect(restoreCountOrder(stored, "initial", saved)).toBe(EMPTY_COUNT_ORDER);
  });
});

describe("buscador y filtro de diferencias", () => {
  type Row = { id: string; name: string; category: string | null; barcode: string | null; barcodes: { barcode: string }[]; tracked: boolean; value: number | null | "invalid"; baseline: number };
  const rows: Row[] = [
    { id: "a", name: "Azúcar", category: "Abarrotes", barcode: "770100", barcodes: [{ barcode: "770100" }, { barcode: "ALT-9" }], tracked: true, value: null, baseline: 10 },
    { id: "b", name: "Burrata", category: "Lácteos", barcode: null, barcodes: [], tracked: true, value: 4, baseline: 10 },
    { id: "c", name: "Campari", category: "Licores", barcode: "880200", barcodes: [{ barcode: "880200" }], tracked: true, value: 12, baseline: 10 },
    { id: "d", name: "Domicilio", category: null, barcode: null, barcodes: [], tracked: false, value: null, baseline: 0 },
    { id: "e", name: "Espinaca", category: "Verduras", barcode: null, barcodes: [], tracked: true, value: 10, baseline: 10 },
    { id: "f", name: "Fresa", category: "Frutas", barcode: null, barcodes: [], tracked: true, value: "invalid", baseline: 10 },
  ];
  const view = (row: Row) => ({ ingredient: row, tracked: row.tracked, value: row.value, baseline: row.baseline });
  const filter = (q: string, f: "all" | "shortage" | "surplus" | "pending", pinned?: string[]) =>
    filterCountItems(rows, { q, filter: f, view, pinned: pinned ? new Set(pinned) : undefined }).map((row) => row.id);

  it("sin filtros pasa todo, en el mismo orden", () => {
    expect(filter("", "all")).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("busca por nombre o categoría sin tildes ni mayúsculas", () => {
    expect(filter("azucar", "all")).toEqual(["a"]);
    expect(filter("  LICORES ", "all")).toEqual(["c"]);
  });

  it("busca por cualquiera de los códigos de barras, también con la basura del lector", () => {
    expect(filter("880200", "all")).toEqual(["c"]);
    expect(filter(" alt-9\r\n", "all")).toEqual(["a"]);
    expect(filter("7701", "all")).toEqual(["a"]);
    expect(filter("999999", "all")).toEqual([]);
  });

  it("filtra faltantes, sobrantes y pendientes; los no inventariables y lo inválido quedan fuera", () => {
    expect(filter("", "shortage")).toEqual(["b"]);
    expect(filter("", "surplus")).toEqual(["c"]);
    expect(filter("", "pending")).toEqual(["a"]);
  });

  it("combina buscador y filtro", () => {
    expect(filter("burr", "shortage")).toEqual(["b"]);
    expect(filter("burr", "surplus")).toEqual([]);
  });

  it("la fila escaneada o en edición nunca desaparece por un filtro", () => {
    expect(filter("zzz", "surplus", ["a", "d"])).toEqual(["a", "d"]);
    expect(filter("", "pending", ["c"])).toEqual(["a", "c"]);
  });
});

describe("estado de la fila y contadores", () => {
  it("clasifica cada fila", () => {
    expect(countRowState(null, 10, true)).toBe("pending");
    expect(countRowState("invalid", 10, true)).toBe("invalid");
    expect(countRowState(10, 10, true)).toBe("equal");
    expect(countRowState(0, 0, true)).toBe("equal");
    expect(countRowState(9, 10, true)).toBe("shortage");
    expect(countRowState(11, 10, true)).toBe("surplus");
    expect(countRowState(11, 10, false)).toBe("untracked");
  });

  it("cuenta como la tira de filtros: lo inválido sigue pendiente y lo no inventariable no cuenta", () => {
    expect(countStats(["pending", "invalid", "equal", "shortage", "shortage", "surplus", "untracked"])).toEqual({
      counted: 4, diffs: 3, shortages: 2, surpluses: 1, equal: 1, pending: 2,
    });
    expect(countStats([])).toEqual({ counted: 0, diffs: 0, shortages: 0, surpluses: 0, equal: 0, pending: 0 });
  });
});

describe("cantidades parciales de una fila", () => {
  const entry = (raw: string, unit = "kg") => ({ raw, unit });

  it("una sola cantidad se edita en línea", () => {
    expect(summarizeCountParts([entry("")], "mass")).toEqual({ parts: 1, filled: 0, invalid: false, multi: false });
    expect(summarizeCountParts([entry("1,5")], "mass")).toEqual({ parts: 1, filled: 1, invalid: false, multi: false });
  });

  it("varias cantidades muestran el chip; el cero cuenta y el blanco no", () => {
    expect(summarizeCountParts([entry("12"), entry("0"), entry("")], "mass")).toEqual({ parts: 3, filled: 2, invalid: false, multi: true });
  });

  it("marca lo inválido sin contarlo como lleno", () => {
    expect(summarizeCountParts([entry("12"), entry("0.0001", "g")], "mass")).toEqual({ parts: 2, filled: 1, invalid: true, multi: true });
  });

  it("al soltar la fila descarta los campos en blanco y conserva al menos uno", () => {
    expect(pruneBlankCountParts([entry("12"), entry(""), entry("3"), entry("  ")])).toEqual([entry("12"), entry("3")]);
    expect(pruneBlankCountParts([entry(""), entry("", "g")])).toEqual([entry("")]);
    expect(pruneBlankCountParts([entry("")])).toEqual([entry("")]);
    expect(pruneBlankCountParts([])).toEqual([]);
  });

  it("no descarta el cero ni lo inválido (hay que corregirlo, no perderlo)", () => {
    expect(pruneBlankCountParts([entry("0"), entry("abc"), entry("")])).toEqual([entry("0"), entry("abc")]);
  });
});

describe("código escaneado → insumo", () => {
  const countItems = [
    { id: "item-ron", ingredient: { barcode: "RON-1", barcodes: [{ barcode: "RON-1" }, { barcode: "RON-ALT" }], category: "Licores" } },
    { id: "item-gin", ingredient: { barcode: null, barcodes: [{ barcode: " GIN 7\r\n" }], category: "Licores" } },
  ];

  it("indexa el código principal y los adicionales, normalizados", () => {
    const index = buildCountBarcodeIndex(countItems);
    expect(index.get("RON-1")).toBe("item-ron");
    expect(index.get("RON-ALT")).toBe("item-ron");
    expect(index.get("GIN7")).toBe("item-gin");
    // Las mayúsculas y minúsculas distinguen códigos (Code128).
    expect(index.get("ron-1")).toBeUndefined();
    expect(index.size).toBe(3);
  });

  it("deduce la categoría del conteo solo cuando todos sus insumos la comparten", () => {
    expect(countScopeCategory(countItems)).toBe("Licores");
    expect(countScopeCategory([...countItems, { ingredient: { category: "Abarrotes" } }])).toBeNull();
    expect(countScopeCategory([{ ingredient: { category: null } }])).toBeNull();
    expect(countScopeCategory([])).toBeNull();
  });

  const owner = { id: "x", name: "Vino blanco", active: true, trackInventory: true, category: "Licores" };
  const context = { inCount: false, excludedCategories: ["Aseo"], scopeCategory: null as string | null };

  it("si el insumo está en el conteo, eso manda sobre todo lo demás", () => {
    expect(classifyScanOwner({ ...owner, active: false }, { ...context, inCount: true })).toBe("in_count");
  });

  it("explica por qué no está: archivado, sin inventario, categoría sin inventario, otra categoría o agregado después", () => {
    expect(classifyScanOwner({ ...owner, active: false, trackInventory: false, category: "Aseo" }, context)).toBe("archived");
    expect(classifyScanOwner({ ...owner, trackInventory: false, category: "Aseo" }, context)).toBe("not_tracked");
    expect(classifyScanOwner({ ...owner, category: "Aseo" }, { ...context, scopeCategory: "Licores" })).toBe("category_excluded");
    expect(classifyScanOwner({ ...owner, category: "Abarrotes" }, { ...context, scopeCategory: "Licores" })).toBe("outside_scope");
    expect(classifyScanOwner({ ...owner, category: null }, { ...context, scopeCategory: "Licores" })).toBe("outside_scope");
    expect(classifyScanOwner(owner, { ...context, scopeCategory: "Licores" })).toBe("added_later");
    expect(classifyScanOwner(owner, context)).toBe("added_later");
  });

  it("solo se puede sumar al conteo lo activo e inventariable", () => {
    expect(["in_count", "archived", "not_tracked", "category_excluded", "outside_scope", "added_later"].filter((state) => canAppendScanOwner(state as never)))
      .toEqual(["outside_scope", "added_later"]);
  });
});
