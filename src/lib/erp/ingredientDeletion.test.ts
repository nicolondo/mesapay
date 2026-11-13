import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ lock: vi.fn(), audit: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/orderLock", () => ({ lockStock: m.lock }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/db", () => ({ db: { $transaction: m.transaction } }));

import {
  deletableIngredientIds,
  deleteIngredientsPermanently,
  ingredientDeletionCheck,
  ingredientDeletionChecks,
  IngredientDeletionConflict,
  previewIngredientDeletion,
  runIngredientDeletion,
} from "./ingredientDeletion";

// Una base en memoria con SOLO lo que la regla consulta. Cada prueba arma
// las filas que referencian al insumo y la regla decide.
type Data = {
  ingredients: { id: string; restaurantId: string; name: string; category?: string | null; barcode?: string | null; active?: boolean }[];
  stockLevels: { ingredientId: string; qtyBase: number; totalValueCents: number }[];
  movements: { ingredientId: string }[];
  orders: { id: string; number: number; status: string }[];
  orderItems: { ingredientId: string; purchaseOrderId: string; supplierItemId?: string | null }[];
  supplierItems: { id: string; ingredientId: string }[];
  priceHistory: { supplierItemId: string }[];
  batches: { outputIngredientId: string }[];
  counts: { id: string; status: string; createdAt: Date }[];
  countItems: { ingredientId: string; countId: string }[];
  recipes: { id: string; dish?: string; outputIngredientId?: string }[];
  recipeItems: { recipeId: string; ingredientId: string }[];
  modifierItems: { recipeId: string; ingredientId: string; optLabel: string }[];
  barcodes: { ingredientId: string; barcode: string }[];
  aliases: { ingredientId: string }[];
  /** Filas que otra transacción tiene tomadas (FOR UPDATE SKIP LOCKED las salta). */
  lockedElsewhere: string[];
};
let data: Data;
const calls: string[] = [];

type Where = Record<string, unknown>;
const inList = (where: Where, key: string) => (where[key] as { in: string[] }).in;
function grouped<T>(rows: T[], keys: (keyof T)[]) {
  const groups = new Map<string, T & { _count: { _all: number } }>();
  for (const row of rows) {
    const id = keys.map((key) => String(row[key])).join("|");
    const group = groups.get(id) ?? { ...row, _count: { _all: 0 } };
    group._count._all++;
    groups.set(id, group);
  }
  return [...groups.values()];
}
const statusOf = (orderId: string) => data.orders.find((order) => order.id === orderId)!.status;
const countOf = (countId: string) => data.counts.find((count) => count.id === countId)!;
const recipeOf = (recipeId: string) => data.recipes.find((recipe) => recipe.id === recipeId)!;

const client = {
  ingredient: {
    findMany: async ({ where }: { where: Where }) => data.ingredients
      .filter((row) => row.restaurantId === where.restaurantId && (where.id
        ? inList(where, "id").includes(row.id)
        // Candidatos de la lista: sin saldo, o con saldo en cero.
        : !data.stockLevels.some((level) => level.ingredientId === row.id && (level.qtyBase !== 0 || level.totalValueCents !== 0))))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => ({
        category: null, sku: null, active: true, barcode: null, measureKind: "mass", ...row,
        barcodes: data.barcodes.filter((code) => code.ingredientId === row.id).map((code) => ({ barcode: code.barcode })),
      })),
    deleteMany: async ({ where }: { where: Where }) => {
      calls.push("delete");
      const ids = inList(where, "id");
      const before = data.ingredients.length;
      data.ingredients = data.ingredients.filter((row) => !(row.restaurantId === where.restaurantId && ids.includes(row.id)));
      return { count: before - data.ingredients.length };
    },
  },
  stockLevel: {
    findMany: async ({ where }: { where: Where }) => data.stockLevels.filter((row) =>
      inList(where, "ingredientId").includes(row.ingredientId) && (row.qtyBase !== 0 || row.totalValueCents !== 0)),
  },
  stockMovement: {
    groupBy: async ({ where }: { where: Where }) => {
      calls.push("check");
      return grouped(data.movements.filter((row) => inList(where, "ingredientId").includes(row.ingredientId)), ["ingredientId"]);
    },
  },
  purchaseOrderItem: {
    groupBy: async ({ by, where }: { by: string[]; where: Where }) => by.includes("supplierItemId")
      ? grouped(data.orderItems.filter((row) => !!row.supplierItemId && inList(where, "supplierItemId").includes(row.supplierItemId)), ["supplierItemId", "ingredientId", "purchaseOrderId"])
      : grouped(data.orderItems.filter((row) => inList(where, "ingredientId").includes(row.ingredientId) && statusOf(row.purchaseOrderId) !== "draft"), ["ingredientId", "purchaseOrderId"]),
    findMany: async ({ where }: { where: Where }) => data.orderItems
      .filter((row) => inList(where, "ingredientId").includes(row.ingredientId) && statusOf(row.purchaseOrderId) === "draft")
      .map((row) => ({ ingredientId: row.ingredientId, purchaseOrder: data.orders.find((order) => order.id === row.purchaseOrderId)! })),
  },
  supplierIngredient: {
    findMany: async ({ where }: { where: Where }) => data.supplierItems.filter((row) => inList(where, "ingredientId").includes(row.ingredientId)),
  },
  supplierPriceHistory: {
    groupBy: async ({ where }: { where: Where }) => grouped(data.priceHistory.filter((row) => inList(where, "supplierItemId").includes(row.supplierItemId)), ["supplierItemId"]),
  },
  productionBatch: {
    groupBy: async ({ where }: { where: Where }) => grouped(data.batches.filter((row) => inList(where, "outputIngredientId").includes(row.outputIngredientId)), ["outputIngredientId"]),
  },
  stockCountItem: {
    groupBy: async ({ where }: { where: Where }) => grouped(data.countItems.filter((row) =>
      inList(where, "ingredientId").includes(row.ingredientId) && countOf(row.countId).status !== "draft"), ["ingredientId"]),
    findMany: async ({ where }: { where: Where }) => data.countItems
      .filter((row) => inList(where, "ingredientId").includes(row.ingredientId) && countOf(row.countId).status === "draft")
      .map((row) => ({ ingredientId: row.ingredientId, count: { createdAt: countOf(row.countId).createdAt } })),
  },
  recipeItem: {
    findMany: async ({ where }: { where: Where }) => data.recipeItems
      .filter((row) => inList(where, "ingredientId").includes(row.ingredientId))
      .map((row) => {
        const recipe = recipeOf(row.recipeId);
        const output = data.ingredients.find((item) => item.id === recipe.outputIngredientId);
        return { ingredientId: row.ingredientId, recipe: { menuItem: recipe.dish ? { name: recipe.dish } : null, outputIngredient: output ? { name: output.name } : null } };
      }),
  },
  modifierRecipeItem: {
    findMany: async ({ where }: { where: Where }) => data.modifierItems
      .filter((row) => inList(where, "ingredientId").includes(row.ingredientId))
      .map((row) => ({ ingredientId: row.ingredientId, optLabel: row.optLabel, recipe: { menuItem: { name: recipeOf(row.recipeId).dish! } } })),
  },
  recipe: {
    findMany: async ({ where }: { where: Where }) => data.recipes
      .filter((row) => !!row.outputIngredientId && inList(where, "outputIngredientId").includes(row.outputIngredientId))
      .map((row) => ({
        outputIngredientId: row.outputIngredientId!,
        items: data.recipeItems.filter((item) => item.recipeId === row.id).map((_, index) => ({ id: `${row.id}-${index}` })),
        modifierItems: data.modifierItems.filter((item) => item.recipeId === row.id).map((_, index) => ({ id: `${row.id}-m${index}` })),
      })),
  },
  ingredientBarcode: {
    groupBy: async ({ where }: { where: Where }) => grouped(data.barcodes.filter((row) => inList(where, "ingredientId").includes(row.ingredientId)), ["ingredientId"]),
  },
  supplierInvoiceAlias: {
    groupBy: async ({ where }: { where: Where }) => grouped(data.aliases.filter((row) => inList(where, "ingredientId").includes(row.ingredientId)), ["ingredientId"]),
  },
  // SELECT … FOR UPDATE SKIP LOCKED: devuelve las filas que se pudieron tomar.
  $queryRaw: async (_strings: TemplateStringsArray, restaurantId: string, ids: { values: string[] }) => {
    calls.push("row-lock");
    return data.ingredients
      .filter((row) => row.restaurantId === restaurantId && ids.values.includes(row.id) && !data.lockedElsewhere.includes(row.id))
      .map((row) => ({ id: row.id }));
  },
};
type Tx = Parameters<typeof ingredientDeletionCheck>[0];
const tx = client as unknown as Tx;
const check = (id = "ing") => ingredientDeletionCheck(tx, "r", id);

beforeEach(() => {
  vi.resetAllMocks();
  calls.length = 0;
  m.lock.mockImplementation(async () => { calls.push("stock-lock"); });
  m.transaction.mockImplementation((run: (client: Tx) => unknown) => run(tx));
  data = {
    ingredients: [{ id: "ing", restaurantId: "r", name: "Tomate" }, { id: "other", restaurantId: "r", name: "Cebolla" }, { id: "foreign", restaurantId: "r2", name: "Ajeno" }],
    stockLevels: [], movements: [], orderItems: [], supplierItems: [], priceHistory: [], batches: [], countItems: [],
    recipeItems: [], modifierItems: [], barcodes: [], aliases: [], lockedElsewhere: [],
    orders: [{ id: "po-draft", number: 7, status: "draft" }, { id: "po-draft-2", number: 12, status: "draft" }, { id: "po-sent", number: 3, status: "sent" }, { id: "po-received", number: 4, status: "received" }, { id: "po-canceled", number: 5, status: "canceled" }],
    counts: [{ id: "count-closed", status: "closed", createdAt: new Date("2026-10-01T15:00:00.000Z") }, { id: "count-draft", status: "draft", createdAt: new Date("2026-11-12T14:30:00.000Z") }],
    recipes: [{ id: "r-ajiaco", dish: "Ajiaco" }, { id: "r-bandeja", dish: "Bandeja paisa" }, { id: "r-hogao", outputIngredientId: "other" }, { id: "r-own", outputIngredientId: "ing" }],
  };
});

describe("la regla: qué bloquea eliminar un insumo", () => {
  it("sin ninguna referencia se puede eliminar, y dice qué se va con él", async () => {
    data.barcodes.push({ ingredientId: "ing", barcode: "1" }, { ingredientId: "ing", barcode: "2" });
    data.supplierItems.push({ id: "s1", ingredientId: "ing" });
    data.aliases.push({ ingredientId: "ing" }, { ingredientId: "ing" }, { ingredientId: "ing" });
    data.stockLevels.push({ ingredientId: "ing", qtyBase: 0, totalValueCents: 0 });
    expect(await check()).toEqual({ deletable: true, removes: { barcodes: 2, supplierItems: 1, invoiceAliases: 3 } });
  });

  it("no existe en este comercio → null (aunque exista en otro)", async () => {
    expect(await check("nope")).toBeNull();
    expect(await check("foreign")).toBeNull();
    expect(await ingredientDeletionCheck(tx, "r2", "foreign")).toEqual({ deletable: true, removes: { barcodes: 0, supplierItems: 0, invoiceAliases: 0 } });
  });

  const blockers: [string, () => void, { code: string; count: number; labels?: string[] }][] = [
    ["movimientos de inventario", () => { data.movements.push({ ingredientId: "ing" }, { ingredientId: "ing" }, { ingredientId: "ing" }); }, { code: "movements", count: 3 }],
    ["existencias (cantidad)", () => { data.stockLevels.push({ ingredientId: "ing", qtyBase: -5, totalValueCents: 0 }); }, { code: "stock", count: 1 }],
    ["existencias (solo valor)", () => { data.stockLevels.push({ ingredientId: "ing", qtyBase: 0, totalValueCents: 12 }); }, { code: "stock", count: 1 }],
    ["órdenes enviadas, recibidas o anuladas: cuenta órdenes, no líneas", () => {
      data.orderItems.push({ ingredientId: "ing", purchaseOrderId: "po-sent" }, { ingredientId: "ing", purchaseOrderId: "po-sent" },
        { ingredientId: "ing", purchaseOrderId: "po-received" }, { ingredientId: "ing", purchaseOrderId: "po-canceled" });
    }, { code: "purchases", count: 3 }],
    ["órdenes en borrador, con su número", () => {
      data.orderItems.push({ ingredientId: "ing", purchaseOrderId: "po-draft-2" }, { ingredientId: "ing", purchaseOrderId: "po-draft" }, { ingredientId: "ing", purchaseOrderId: "po-draft" });
    }, { code: "draftPurchases", count: 2, labels: ["7", "12"] }],
    ["una orden que usa su presentación con otro insumo", () => {
      data.supplierItems.push({ id: "s1", ingredientId: "ing" });
      data.orderItems.push({ ingredientId: "other", purchaseOrderId: "po-draft", supplierItemId: "s1" });
    }, { code: "purchases", count: 1 }],
    ["historial de precios de sus presentaciones", () => {
      data.supplierItems.push({ id: "s1", ingredientId: "ing" }, { id: "s2", ingredientId: "ing" });
      data.priceHistory.push({ supplierItemId: "s1" }, { supplierItemId: "s2" }, { supplierItemId: "s2" });
    }, { code: "priceHistory", count: 3 }],
    ["lotes de producción", () => { data.batches.push({ outputIngredientId: "ing" }, { outputIngredientId: "ing" }); }, { code: "production", count: 2 }],
    ["conteos cerrados", () => { data.countItems.push({ ingredientId: "ing", countId: "count-closed" }); }, { code: "closedCounts", count: 1 }],
    ["el conteo en borrador, con su fecha", () => { data.countItems.push({ ingredientId: "ing", countId: "count-draft" }); },
      { code: "draftCount", count: 1, labels: ["2026-11-12T14:30:00.000Z"] }],
    ["recetas de platos y sub-recetas, con sus nombres", () => {
      data.recipeItems.push({ recipeId: "r-ajiaco", ingredientId: "ing" }, { recipeId: "r-hogao", ingredientId: "ing" });
    }, { code: "recipes", count: 2, labels: ["Ajiaco", "Cebolla"] }],
    ["opciones de modificador", () => { data.modifierItems.push({ recipeId: "r-bandeja", ingredientId: "ing", optLabel: "Extra queso" }); },
      { code: "modifierRecipes", count: 1, labels: ["Bandeja paisa · Extra queso"] }],
    ["ser una sub-receta con líneas", () => { data.recipeItems.push({ recipeId: "r-own", ingredientId: "other" }, { recipeId: "r-own", ingredientId: "foreign" }); },
      { code: "ownRecipe", count: 2 }],
  ];
  it.each(blockers)("bloquea: %s", async (_label, arrange, reason) => {
    arrange();
    expect(await check()).toEqual({ deletable: false, reasons: [reason] });
  });

  it("una línea de orden normal no se cuenta dos veces por su presentación", async () => {
    data.supplierItems.push({ id: "s1", ingredientId: "ing" });
    data.orderItems.push({ ingredientId: "ing", purchaseOrderId: "po-received", supplierItemId: "s1" });
    expect(await check()).toEqual({ deletable: false, reasons: [{ code: "purchases", count: 1 }] });
  });

  it.each([
    ["una presentación de proveedor sin órdenes ni historial", () => { data.supplierItems.push({ id: "s1", ingredientId: "ing" }); }],
    ["un saldo en cero", () => { data.stockLevels.push({ ingredientId: "ing", qtyBase: 0, totalValueCents: 0 }); }],
    ["una sub-receta vacía", () => undefined],
    ["códigos de barras y nombres de factura", () => { data.barcodes.push({ ingredientId: "ing", barcode: "1" }); data.aliases.push({ ingredientId: "ing" }); }],
    ["lo que referencia a OTRO insumo", () => {
      data.movements.push({ ingredientId: "other" });
      data.recipeItems.push({ recipeId: "r-ajiaco", ingredientId: "other" });
      data.orderItems.push({ ingredientId: "other", purchaseOrderId: "po-received" });
      data.countItems.push({ ingredientId: "other", countId: "count-closed" });
    }],
  ])("no bloquea: %s", async (_label, arrange) => {
    arrange();
    expect(await check()).toMatchObject({ deletable: true });
  });

  it("junta los motivos en orden fijo y nombra hasta tres", async () => {
    data.recipes.push({ id: "r-c", dish: "Cazuela" }, { id: "r-s", dish: "Sancocho" });
    for (const recipeId of ["r-ajiaco", "r-bandeja", "r-c", "r-s"]) data.recipeItems.push({ recipeId, ingredientId: "ing" });
    data.priceHistory.push({ supplierItemId: "s1" });
    data.supplierItems.push({ id: "s1", ingredientId: "ing" });
    data.movements.push({ ingredientId: "ing" });
    data.stockLevels.push({ ingredientId: "ing", qtyBase: 10, totalValueCents: 100 });
    expect(await check()).toEqual({ deletable: false, reasons: [
      { code: "stock", count: 1 },
      { code: "movements", count: 1 },
      { code: "recipes", count: 4, labels: ["Ajiaco", "Bandeja paisa", "Cazuela"] },
      { code: "priceHistory", count: 1 },
    ] });
  });

  it("varios a la vez: cada uno con lo suyo, sin los de otro comercio", async () => {
    data.movements.push({ ingredientId: "other" });
    const checks = await ingredientDeletionChecks(tx, "r", ["ing", "other", "foreign", "ing", "nope"]);
    expect([...checks.keys()].sort()).toEqual(["ing", "other"]);
    expect(checks.get("ing")).toMatchObject({ deletable: true });
    expect(checks.get("other")).toEqual({ deletable: false, reasons: [{ code: "movements", count: 1 }] });
  });
});

describe("cuáles se pueden eliminar (lista de Insumos)", () => {
  it("ni consulta los que tienen existencias, y devuelve solo los eliminables del comercio", async () => {
    data.ingredients.push({ id: "stocked", restaurantId: "r", name: "Con saldo" }, { id: "valued", restaurantId: "r", name: "Con valor" });
    data.stockLevels.push(
      { ingredientId: "stocked", qtyBase: 3, totalValueCents: 0 },
      { ingredientId: "valued", qtyBase: 0, totalValueCents: 9 },
      { ingredientId: "other", qtyBase: 0, totalValueCents: 0 },
    );
    data.movements.push({ ingredientId: "other" });
    expect(await deletableIngredientIds(tx, "r")).toEqual(["ing"]);
    expect(await deletableIngredientIds(tx, "r2")).toEqual(["foreign"]);
    expect(await deletableIngredientIds(tx, "nadie")).toEqual([]);
  });

  it("la vista previa separa eliminables, bloqueados y ajenos, sin borrar", async () => {
    data.movements.push({ ingredientId: "other" });
    expect(await previewIngredientDeletion(tx, "r", ["other", "ing", "foreign"])).toEqual({
      deletable: [{ id: "ing", name: "Tomate" }],
      skipped: [{ id: "other", name: "Cebolla", reasons: [{ code: "movements", count: 1 }] }],
      missing: ["foreign"],
    });
    expect(data.ingredients).toHaveLength(3);
    expect(calls).not.toContain("delete");
  });
});

describe("eliminar dentro de la transacción", () => {
  it("toma el candado de inventario, bloquea las filas, vuelve a revisar y recién ahí borra", async () => {
    data.ingredients[0] = { id: "ing", restaurantId: "r", name: "Tomate", category: "Verduras", barcode: "PRIMARY", active: false };
    data.barcodes.push({ ingredientId: "ing", barcode: "EXTRA" }, { ingredientId: "ing", barcode: "PRIMARY" });
    data.supplierItems.push({ id: "s1", ingredientId: "ing" });
    const result = await deleteIngredientsPermanently(tx, "r", ["ing"]);
    expect(calls).toEqual(["stock-lock", "row-lock", "check", "delete"]);
    expect(m.lock).toHaveBeenCalledWith(tx, "r");
    expect(result).toEqual({
      deleted: [{
        id: "ing", name: "Tomate", category: "Verduras", measureKind: "mass", sku: null, active: false,
        barcodes: ["PRIMARY", "EXTRA"], removes: { barcodes: 2, supplierItems: 1, invoiceAliases: 0 },
      }],
      skipped: [], missing: [],
    });
    expect(data.ingredients.map((row) => row.id)).toEqual(["other", "foreign"]);
  });

  it("no borra los bloqueados ni los de otro comercio, y los reporta", async () => {
    data.movements.push({ ingredientId: "other" });
    const result = await deleteIngredientsPermanently(tx, "r", ["other", "foreign", "nope", "ing", "ing"]);
    expect(result.deleted.map((row) => row.id)).toEqual(["ing"]);
    expect(result.skipped).toEqual([{ id: "other", name: "Cebolla", reasons: [{ code: "movements", count: 1 }] }]);
    expect(result.missing).toEqual(["foreign", "nope"]);
    expect(data.ingredients.map((row) => row.id)).toEqual(["other", "foreign"]);
  });

  it("un insumo tomado por otra operación se salta como ocupado, sin revisarlo ni borrarlo", async () => {
    data.lockedElsewhere.push("ing");
    const result = await deleteIngredientsPermanently(tx, "r", ["ing"]);
    expect(result).toEqual({ deleted: [], skipped: [{ id: "ing", name: "Tomate", reasons: [{ code: "busy", count: 1 }] }], missing: [] });
    expect(calls).toEqual(["stock-lock", "row-lock"]);
  });

  it("si no hay ninguno del comercio, no bloquea filas ni borra", async () => {
    expect(await deleteIngredientsPermanently(tx, "r", ["foreign", "nope"])).toEqual({ deleted: [], skipped: [], missing: ["foreign", "nope"] });
    expect(calls).toEqual(["stock-lock"]);
  });

  it("si la base borra menos filas de las revisadas, aborta para deshacer todo", async () => {
    const original = client.ingredient.deleteMany;
    client.ingredient.deleteMany = async () => ({ count: 0 });
    try {
      await expect(deleteIngredientsPermanently(tx, "r", ["ing"])).rejects.toBeInstanceOf(IngredientDeletionConflict);
    } finally {
      client.ingredient.deleteMany = original;
    }
  });
});

describe("la operación completa (transacción + auditoría)", () => {
  it("registra un evento por insumo eliminado, con nombre, categoría y códigos", async () => {
    data.ingredients[0] = { id: "ing", restaurantId: "r", name: "Tomate", category: "Verduras", barcode: "770" };
    data.barcodes.push({ ingredientId: "ing", barcode: "770" });
    data.movements.push({ ingredientId: "other" });
    const result = await runIngredientDeletion("r", ["ing", "other"]);
    expect(result).toMatchObject({ deleted: [{ id: "ing" }], skipped: [{ id: "other" }] });
    expect(m.transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 60_000 });
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith({
      kind: "ingredient.delete", restaurantId: "r", target: { type: "ingredient", id: "ing" }, summary: "Tomate",
      diff: { before: { name: "Tomate", category: "Verduras", measureKind: "mass", sku: null, active: true, barcodes: ["770"], supplierItems: 0, invoiceAliases: 0 } },
    });
  });

  it("no audita cuando no se eliminó nada", async () => {
    data.movements.push({ ingredientId: "ing" });
    await runIngredientDeletion("r", ["ing"]);
    expect(m.audit).not.toHaveBeenCalled();
  });

  const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "test", meta });
  it.each([
    ["una llave foránea que apareció a último momento", known("P2003")],
    ["un abrazo mortal", known("P2034")],
    ["la transacción no arrancó o venció", known("P2028")],
    ["un abrazo mortal en la consulta cruda", known("P2010", { code: "40P01" })],
    ["el candado de fila no disponible", known("P2010", { code: "55P03" })],
    ["el mensaje crudo de PostgreSQL", new Error("ERROR: deadlock detected")],
    ["la cuenta de borrados no cuadra", new IngredientDeletionConflict()],
  ])("%s → conflicto, sin auditoría", async (_label, error) => {
    m.transaction.mockRejectedValue(error);
    expect(await runIngredientDeletion("r", ["ing"])).toEqual({ error: "conflict" });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it.each([known("P2002"), known("P2010", { code: "42601" }), new Error("boom")])("un error que no es de concurrencia se propaga: %s", async (error) => {
    m.transaction.mockRejectedValue(error);
    await expect(runIngredientDeletion("r", ["ing"])).rejects.toBe(error);
  });
});
