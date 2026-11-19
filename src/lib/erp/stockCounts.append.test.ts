import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Sumar un insumo a un conteo en borrador (alta desde la pantalla del conteo)
// y cerrar un conteo con un insumo recién creado, sin existencias ni costo.
type Item = { id: string; ingredientId: string; expectedQty: number; countedQty: number | null; countedParts: number[]; preliminaryQty: number | null; preliminaryParts: number[]; finalExpectedQty: number | null; ingredient: { id: string; trackInventory: boolean } };
type Count = { id: string; restaurantId: string; status: string; revision: number; preliminaryAt: Date | null; recountStartedAt: Date | null; recountSnapshot: unknown; finalReview: unknown; items: Item[] };
type Ingredient = { id: string; restaurantId: string; active: boolean; trackInventory: boolean; category: string | null; measureKind: string; stockLevel: { qtyBase: number; totalValueCents: number } | null; movements: number };

const m = vi.hoisted(() => ({
  count: null! as Count,
  ingredients: [] as Ingredient[],
  events: [] as string[],
  apply: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/lib/orderLock", () => ({ lockStock: m.lock }));
vi.mock("@/lib/erp/stock", () => ({ applyStockMovement: m.apply }));
vi.mock("@/lib/db", () => {
  const tx = {
    stockCount: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; restaurantId: string } }) => { m.events.push("read"); return m.count?.id === where.id && m.count?.restaurantId === where.restaurantId ? structuredClone(m.count) : null; }),
      // `Prisma.DbNull` es NULL en la base: al leerlo vuelve como null.
      update: vi.fn(async ({ data }: { data: Partial<Count> }) => { Object.assign(m.count, data, data.finalReview === Prisma.DbNull ? { finalReview: null } : {}); return m.count; }),
      findUniqueOrThrow: vi.fn(async () => structuredClone(m.count)),
      delete: vi.fn(),
    },
    stockCountItem: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Item> }) => { Object.assign(m.count.items.find((item) => item.id === where.id)!, data); }),
      create: vi.fn(async ({ data }: { data: { ingredientId: string; expectedQty: number; finalExpectedQty?: number } }) => {
        const ingredient = m.ingredients.find((candidate) => candidate.id === data.ingredientId)!;
        const item: Item = {
          id: `item-${data.ingredientId}`, ingredientId: data.ingredientId, expectedQty: data.expectedQty, countedQty: null, countedParts: [],
          preliminaryQty: null, preliminaryParts: [], finalExpectedQty: data.finalExpectedQty ?? null,
          ingredient: { id: ingredient.id, trackInventory: ingredient.trackInventory },
        };
        m.count.items.push(item);
        return item;
      }),
    },
    ingredient: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; restaurantId: string } }) => {
        const found = m.ingredients.find((ingredient) => ingredient.id === where.id && ingredient.restaurantId === where.restaurantId);
        return found ? structuredClone(found) : null;
      }),
      // Orden de la base (por id), que no es el orden en que se guardó el
      // snapshot. Respeta el where: por ids (snapshot) o por categorías
      // (agregar categorías al conteo).
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const matchCategory = (clause: { category?: null | { in: string[] } }, candidate: Ingredient) =>
          clause.category === null ? candidate.category === null : clause.category ? clause.category.in.includes(candidate.category ?? "") : true;
        let list = m.ingredients.filter((candidate) => candidate.restaurantId === where.restaurantId);
        const idIn = (where.id as { in?: string[] } | undefined)?.in;
        if (idIn) list = list.filter((candidate) => idIn.includes(candidate.id));
        if (typeof where.active === "boolean") list = list.filter((candidate) => candidate.active === where.active);
        if (typeof where.trackInventory === "boolean") list = list.filter((candidate) => candidate.trackInventory === where.trackInventory);
        if (Array.isArray(where.OR)) list = list.filter((candidate) => (where.OR as { category?: null | { in: string[] } }[]).some((clause) => matchCategory(clause, candidate)));
        else if ("category" in where) list = list.filter((candidate) => matchCategory(where as { category?: null | { in: string[] } }, candidate));
        return structuredClone(list).sort((a, b) => a.id.localeCompare(b.id));
      }),
    },
    stockMovement: {
      count: vi.fn(async ({ where }: { where: { ingredientId: string | { in: string[] } } }) => {
        const idsIn = typeof where.ingredientId === "string" ? [where.ingredientId] : where.ingredientId.in;
        return m.ingredients.filter((ingredient) => idsIn.includes(ingredient.id)).reduce((sum, ingredient) => sum + ingredient.movements, 0);
      }),
      // Movimientos desde que se abrió el conteo (ninguno en estas pruebas).
      findMany: vi.fn(async () => []),
    },
  };
  return { db: { $transaction: (callback: (client: unknown) => unknown) => callback(tx) } };
});

import { appendStockCountCategories, appendStockCountItem, ingredientCategoryScopeWhere, mutateStockCount, sameStockSnapshot } from "./stockCounts";

const R = "restaurant";
const ingredient = (id: string, overrides: Partial<Ingredient> = {}): Ingredient => ({
  id, restaurantId: R, active: true, trackInventory: true, category: null, measureKind: "count", stockLevel: { qtyBase: 10000, totalValueCents: 5000 }, movements: 2, ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.events = [];
  m.lock.mockImplementation(async () => { m.events.push("lock"); });
  m.ingredients = [
    ingredient("m-rice"),
    // Recién creado desde el conteo: sin saldo, sin costo, sin movimientos.
    ingredient("a-new", { stockLevel: null, movements: 0 }),
    ingredient("z-archived", { active: false }),
    ingredient("z-untracked", { trackInventory: false }),
    ingredient("other-tenant", { restaurantId: "other" }),
  ];
  m.count = {
    id: "count", restaurantId: R, status: "draft", revision: 0, preliminaryAt: null, recountStartedAt: null, recountSnapshot: null, finalReview: null,
    items: [{ id: "item-m-rice", ingredientId: "m-rice", expectedQty: 10000, countedQty: 9000, countedParts: [9000], preliminaryQty: null, preliminaryParts: [], finalExpectedQty: null, ingredient: { id: "m-rice", trackInventory: true } }],
  };
});

const append = (ingredientId = "a-new", revision = m.count.revision) => appendStockCountItem(R, "count", { revision, ingredientId });
const mutate = (action: Parameters<typeof mutateStockCount>[2], extra: Record<string, unknown> = {}) => mutateStockCount(R, "count", action, { revision: m.count.revision, ...extra });
const save = (quantities: Record<string, number>) => mutate("save", { items: Object.entries(quantities).map(([itemId, countedQty]) => ({ itemId, countedQty })) });

describe("sumar un insumo al conteo en borrador", () => {
  it("toma el lock antes de leer, lo agrega con la existencia de ahora (0 si es nuevo) y sube la revisión", async () => {
    const result = await append();
    expect(m.events.slice(0, 2)).toEqual(["lock", "read"]);
    expect(result).toMatchObject({ added: true, itemId: "item-a-new" });
    expect(result.count.revision).toBe(1);
    expect(result.count.items.find((item) => item.id === "item-a-new")).toMatchObject({ expectedQty: 0, countedQty: null, finalExpectedQty: null });
    // Lo ya contado de los demás no se toca.
    expect(result.count.items.find((item) => item.id === "item-m-rice")).toMatchObject({ countedQty: 9000 });
  });

  it("un insumo con existencias entra con su saldo actual como teórico", async () => {
    m.ingredients.push(ingredient("b-late", { stockLevel: { qtyBase: 750, totalValueCents: 300 } }));
    const result = await append("b-late");
    expect(result.count.items.find((item) => item.ingredientId === "b-late")).toMatchObject({ expectedQty: 750 });
  });

  it("es idempotente: si ya está en el conteo devuelve su fila sin escribir", async () => {
    const result = await append("m-rice");
    expect(result).toMatchObject({ added: false, itemId: "item-m-rice" });
    expect(m.count.revision).toBe(0);
    expect(m.count.items).toHaveLength(1);
  });

  it("rechaza una revisión vieja sin escribir (otra ventana cambió el conteo)", async () => {
    m.count.revision = 4;
    await expect(append("a-new", 3)).rejects.toMatchObject({ code: "count_changed", status: 409 });
    expect(m.count.items).toHaveLength(1);
  });

  it("no existe para otro comercio, ni el conteo ni el insumo", async () => {
    await expect(appendStockCountItem("other", "count", { revision: 0, ingredientId: "a-new" })).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(append("other-tenant")).rejects.toMatchObject({ code: "ingredient_not_found", status: 404 });
    await expect(append("ghost")).rejects.toMatchObject({ code: "ingredient_not_found", status: 404 });
    expect(m.count.items).toHaveLength(1);
  });

  it.each([["z-archived", "ingredient_inactive"], ["z-untracked", "ingredient_not_tracked"]])("solo entran insumos activos que llevan inventario: %s", async (id, code) => {
    await expect(append(id)).rejects.toMatchObject({ code, status: 409 });
    expect(m.count.items).toHaveLength(1);
    expect(m.count.revision).toBe(0);
  });

  it("no se puede sobre el informe preliminar, con la revisión final pendiente ni cerrado", async () => {
    await mutate("preliminary");
    await expect(append()).rejects.toMatchObject({ code: "recount_required" });
    await mutate("recount");
    await save({ "item-m-rice": 8000 });
    await mutate("review");
    await expect(append()).rejects.toMatchObject({ code: "count_not_editable" });
    const token = (m.count.finalReview as { token: string }).token;
    await mutate("close", { reviewToken: token });
    await expect(append()).rejects.toMatchObject({ code: "already_closed" });
    expect(m.count.items).toHaveLength(1);
  });
});

describe("conteo con un insumo recién creado", () => {
  it("agregado en el conteo inicial: pasa por preliminar y definitivo, y al cerrar entra como sobrante desde cero", async () => {
    await append();
    await save({ "item-m-rice": 9000, "item-a-new": 4000 });
    await mutate("preliminary");
    expect(m.count.items.find((item) => item.id === "item-a-new")).toMatchObject({ preliminaryQty: 4000, expectedQty: 0 });
    await mutate("recount");
    expect(m.count.items.find((item) => item.id === "item-a-new")).toMatchObject({ countedQty: null, finalExpectedQty: 0 });
    await save({ "item-m-rice": 10000, "item-a-new": 5000 });
    await mutate("review");
    expect(m.apply).not.toHaveBeenCalled();
    const result = await mutate("close", { reviewToken: (m.count.finalReview as { token: string }).token });
    if (!("count" in result)) throw new Error("expected count");
    expect(result.adjustments).toBe(1);
    expect(m.apply).toHaveBeenCalledTimes(1);
    expect(m.apply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ingredientId: "a-new", kind: "count_adjust", qtyBase: 5000, stockCountId: "count" }), { allowInactive: true });
  });

  it("agregado durante el conteo definitivo: entra al snapshot con su saldo de ahora y no dispara «el inventario cambió»", async () => {
    await mutate("preliminary");
    await mutate("recount");
    const before = structuredClone(m.count.recountSnapshot) as { movementCount: number; ingredients: { id: string }[] };
    expect(before).toMatchObject({ movementCount: 2, ingredients: [{ id: "m-rice" }] });
    const result = await append();
    expect(result.count.items.find((item) => item.id === "item-a-new")).toMatchObject({ expectedQty: 0, finalExpectedQty: 0, preliminaryQty: null });
    expect(m.count.recountSnapshot).toEqual({
      // El plan del definitivo se conserva y el recién llegado queda «sin contar».
      full: false,
      recount: { "m-rice": ["difference"], "a-new": ["uncounted"] },
      movementCount: 2,
      ingredients: [
        { id: "m-rice", trackInventory: true, measureKind: "count", qtyBase: 10000, totalValueCents: 5000 },
        { id: "a-new", trackInventory: true, measureKind: "count", qtyBase: 0, totalValueCents: 0 },
      ],
    });
    // Falta contarlo: el definitivo exige todos los insumos.
    await save({ "item-m-rice": 10000 });
    await expect(mutate("review")).rejects.toMatchObject({ code: "incomplete_count" });
    await save({ "item-a-new": 3000 });
    await mutate("review");
    const closed = await mutate("close", { reviewToken: (m.count.finalReview as { token: string }).token });
    if (!("count" in closed)) throw new Error("expected count");
    expect(closed.adjustments).toBe(1);
    expect(m.apply.mock.calls[0][1]).toMatchObject({ ingredientId: "a-new", qtyBase: 3000 });
  });

  it("un insumo con movimientos previos suma sus movimientos al snapshot, y un cambio posterior en OTRO insumo se sigue detectando", async () => {
    m.ingredients.push(ingredient("b-late", { stockLevel: { qtyBase: 750, totalValueCents: 300 }, movements: 5 }));
    await mutate("preliminary");
    await mutate("recount");
    await append("b-late");
    expect((m.count.recountSnapshot as { movementCount: number }).movementCount).toBe(7);
    await save({ "item-m-rice": 10000, "item-b-late": 750 });
    await mutate("review");
    // Una venta del arroz después de iniciar el definitivo.
    m.ingredients.find((candidate) => candidate.id === "m-rice")!.stockLevel!.qtyBase = 9000;
    m.ingredients.find((candidate) => candidate.id === "m-rice")!.movements = 3;
    await expect(mutate("close", { reviewToken: (m.count.finalReview as { token: string }).token })).rejects.toMatchObject({ code: "stock_changed" });
    expect(m.apply).not.toHaveBeenCalled();
  });

  it("un movimiento del insumo agregado, después de agregarlo, también invalida el cierre", async () => {
    await mutate("preliminary");
    await mutate("recount");
    await append();
    await save({ "item-m-rice": 10000, "item-a-new": 3000 });
    const added = m.ingredients.find((candidate) => candidate.id === "a-new")!;
    added.stockLevel = { qtyBase: 2000, totalValueCents: 900 };
    added.movements = 1;
    await expect(mutate("review")).rejects.toMatchObject({ code: "stock_changed" });
  });
});

const appendCategories = (categories: (string | null)[], revision = m.count.revision) =>
  appendStockCountCategories(R, "count", { revision, categories });

describe("filtro de categorías del alcance", () => {
  it("arma el where por nombres, por «Sin categoría» (null) o ambos; vacío = sin filtro", () => {
    expect(ingredientCategoryScopeWhere([])).toEqual({});
    expect(ingredientCategoryScopeWhere(["Licores"])).toEqual({ category: { in: ["Licores"] } });
    expect(ingredientCategoryScopeWhere(["Licores", "Licores", "Abarrotes"])).toEqual({ category: { in: ["Licores", "Abarrotes"] } });
    expect(ingredientCategoryScopeWhere([null])).toEqual({ category: null });
    expect(ingredientCategoryScopeWhere(["Licores", null])).toEqual({ OR: [{ category: { in: ["Licores"] } }, { category: null }] });
  });
});

describe("agregar categorías completas a un conteo", () => {
  beforeEach(() => {
    m.ingredients.push(
      ingredient("l-leche", { category: "Lácteos", stockLevel: { qtyBase: 500, totalValueCents: 200 }, movements: 1 }),
      ingredient("l-queso", { category: "Lácteos", stockLevel: null, movements: 0 }),
      ingredient("l-untracked", { category: "Lácteos", trackInventory: false }),
      ingredient("l-archived", { category: "Lácteos", active: false }),
      ingredient("s-suelto", { category: null, stockLevel: { qtyBase: 30, totalValueCents: 10 }, movements: 4 }),
      ingredient("l-ajeno", { category: "Lácteos", restaurantId: "other" }),
    );
  });

  it("en borrador: entran los activos e inventariables que faltan, con el teórico de ESTE momento, y sube la revisión", async () => {
    const result = await appendCategories(["Lácteos", null]);
    // Lácteos aporta 2 (leche y queso); «Sin categoría» aporta 2 (s-suelto y a-new).
    expect(result.added).toBe(4);
    expect(result.count.revision).toBe(1);
    expect(result.count.items.find((item) => item.ingredientId === "l-leche")).toMatchObject({ expectedQty: 500, countedQty: null, finalExpectedQty: null });
    expect(result.count.items.find((item) => item.ingredientId === "l-queso")).toMatchObject({ expectedQty: 0 });
    // «Sin categoría» (null) también es un alcance válido; a-new no tiene categoría.
    expect(result.count.items.find((item) => item.ingredientId === "s-suelto")).toMatchObject({ expectedQty: 30 });
    expect(result.count.items.find((item) => item.ingredientId === "a-new")).toMatchObject({ expectedQty: 0 });
    // Archivados, no inventariables y de otro comercio no entran.
    for (const excluded of ["l-untracked", "l-archived", "l-ajeno"]) {
      expect(result.count.items.find((item) => item.ingredientId === excluded)).toBeUndefined();
    }
    // Lo ya contado no se toca.
    expect(result.count.items.find((item) => item.id === "item-m-rice")).toMatchObject({ countedQty: 9000 });
  });

  it("el teórico se congela al momento de agregar, no al de abrir el conteo", async () => {
    m.ingredients.find((candidate) => candidate.id === "l-leche")!.stockLevel = { qtyBase: 777, totalValueCents: 300 };
    const result = await appendCategories(["Lácteos"]);
    expect(result.count.items.find((item) => item.ingredientId === "l-leche")).toMatchObject({ expectedQty: 777 });
  });

  it("una categoría ya completa no agrega nada ni sube la revisión", async () => {
    await appendCategories(["Lácteos"]);
    const revision = m.count.revision;
    const again = await appendCategories(["Lácteos"]);
    expect(again.added).toBe(0);
    expect(m.count.revision).toBe(revision);
  });

  it("rechaza revisión vieja, lista vacía y las etapas no editables", async () => {
    await expect(appendCategories(["Lácteos"], m.count.revision + 1)).rejects.toMatchObject({ code: "count_changed", status: 409 });
    await expect(appendCategories([])).rejects.toMatchObject({ code: "invalid", status: 400 });
    await mutate("preliminary");
    await expect(appendCategories(["Lácteos"])).rejects.toMatchObject({ code: "recount_required" });
    await mutate("recount");
    await save({ "item-m-rice": 8000 });
    await mutate("review");
    await expect(appendCategories(["Lácteos"])).rejects.toMatchObject({ code: "count_not_editable" });
    await mutate("close", { reviewToken: (m.count.finalReview as { token: string }).token });
    await expect(appendCategories(["Lácteos"])).rejects.toMatchObject({ code: "already_closed" });
    await expect(appendStockCountCategories("other", "count", { revision: 0, categories: ["Lácteos"] })).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(m.count.items).toHaveLength(1);
  });

  it("durante el definitivo: entran al snapshot con su saldo y movimientos de ahora, quedan «sin contar» y el cierre los exige", async () => {
    await mutate("preliminary");
    await mutate("recount");
    const before = structuredClone(m.count.recountSnapshot) as { movementCount: number };
    const result = await appendCategories(["Lácteos"]);
    expect(result.added).toBe(2);
    // Sin preliminar propio: pendientes honestos, con el teórico de ahora.
    expect(result.count.items.find((item) => item.ingredientId === "l-leche")).toMatchObject({ expectedQty: 500, finalExpectedQty: 500, preliminaryQty: null, countedQty: null });
    const snapshot = m.count.recountSnapshot as { movementCount: number; recount: Record<string, string[]>; ingredients: { id: string }[] };
    expect(snapshot.movementCount).toBe(before.movementCount + 1);
    expect(snapshot.recount).toMatchObject({ "l-leche": ["uncounted"], "l-queso": ["uncounted"] });
    expect(snapshot.ingredients.map((entry) => entry.id)).toEqual(["m-rice", "l-leche", "l-queso"]);
    // Falta contarlos: el definitivo exige todos los insumos.
    await save({ "item-m-rice": 10000 });
    await expect(mutate("review")).rejects.toMatchObject({ code: "incomplete_count" });
    await save({ "item-l-leche": 500, "item-l-queso": 100 });
    await mutate("review");
    const closed = await mutate("close", { reviewToken: (m.count.finalReview as { token: string }).token });
    if (!("count" in closed)) throw new Error("expected count");
    expect(closed.adjustments).toBe(1);
    expect(m.apply.mock.calls[0][1]).toMatchObject({ ingredientId: "l-queso", qtyBase: 100 });
  });
});

describe("comparación de snapshots", () => {
  const a = { id: "a", trackInventory: true, measureKind: "count", qtyBase: 1, totalValueCents: 2 };
  const b = { id: "b", trackInventory: true, measureKind: "mass", qtyBase: 3, totalValueCents: 4 };
  it("no depende del orden de los insumos", () => {
    expect(sameStockSnapshot({ movementCount: 5, ingredients: [a, b] }, { movementCount: 5, ingredients: [b, a] })).toBe(true);
  });
  it("detecta un insumo distinto, uno de más o uno repetido", () => {
    expect(sameStockSnapshot({ movementCount: 5, ingredients: [a, b] }, { movementCount: 5, ingredients: [a, { ...b, id: "c" }] })).toBe(false);
    expect(sameStockSnapshot({ movementCount: 5, ingredients: [a] }, { movementCount: 5, ingredients: [a, b] })).toBe(false);
    expect(sameStockSnapshot({ movementCount: 5, ingredients: [a, b] }, { movementCount: 5, ingredients: [a, a] })).toBe(false);
    expect(sameStockSnapshot({ movementCount: 5, ingredients: [a, b] }, { movementCount: 5, ingredients: [a, { ...b, qtyBase: 9 }] })).toBe(false);
  });
});
