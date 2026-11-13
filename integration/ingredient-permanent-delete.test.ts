import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { applyStockMovement } from "../src/lib/erp/stock";
import { deleteIngredientsPermanently, ingredientDeletionCheck } from "../src/lib/erp/ingredientDeletion";
import { DELETE as archiveIngredient } from "../src/app/api/operator/ingredients/[id]/route";
import { GET as checkRoute, DELETE as deleteRoute } from "../src/app/api/operator/ingredients/[id]/delete/route";
import { POST as bulkDeleteRoute } from "../src/app/api/operator/ingredients/bulk-delete/route";

// Solo se sustituye la sesión: el gate del ERP, la regla, los candados, los
// triggers y las llaves foráneas corren contra PostgreSQL de verdad.
const scope = vi.hoisted(() => ({ restaurantId: "", role: "operator" as string | null }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
vi.mock("../src/auth", () => ({
  auth: async () => (scope.role ? { user: { id: null, email: "delete-validation@example.invalid", role: scope.role } } : null),
}));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
let other: string;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const check = (id: string) => checkRoute(new Request("http://localhost/api/operator/ingredients/x/delete"), params(id));
const remove = (id: string) => deleteRoute(new Request("http://localhost/api/operator/ingredients/x/delete", { method: "DELETE" }), params(id));
const bulk = (ids: unknown) => bulkDeleteRoute(new Request("http://localhost/api/operator/ingredients/bulk-delete", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }),
}));
const ingredient = (data: { name?: string; barcode?: string; active?: boolean; category?: string; restaurantId?: string } = {}) =>
  db.ingredient.create({ data: { restaurantId: scope.restaurantId, name: `Insumo ${randomUUID()}`, measureKind: "mass", ...data } });
const exists = async (id: string) => (await db.ingredient.count({ where: { id } })) === 1;
const supplier = () => db.supplier.create({ data: { restaurantId: scope.restaurantId, name: `Proveedor ${randomUUID()}` } });
const presentation = async (ingredientId: string) => db.supplierIngredient.create({
  data: { supplierId: (await supplier()).id, ingredientId, presentationLabel: "Caja", contentQty: 1000, lastPriceCents: 5000 },
});
let orderNumber = 0;
const order = async (status: "draft" | "sent" | "received" | "canceled", line: { ingredientId: string; supplierItemId?: string }) =>
  db.purchaseOrder.create({ data: {
    restaurantId: scope.restaurantId, supplierId: (await supplier()).id, number: ++orderNumber, status,
    items: { create: [{ ...line, qtyOrderedBase: 1000, expectedCostCents: 5000 }] },
  } });
const dish = async (name = `Plato ${randomUUID()}`) => {
  const category = await db.category.create({ data: { restaurantId: scope.restaurantId, label: "Validación", slug: `validacion-${randomUUID()}` } });
  const item = await db.menuItem.create({ data: { restaurantId: scope.restaurantId, categoryId: category.id, name, priceCents: 1000 } });
  return db.recipe.create({ data: { restaurantId: scope.restaurantId, menuItemId: item.id } });
};
const move = (ingredientId: string, kind: "adjust_in" | "adjust_out", qtyBase: number) =>
  db.$transaction((tx) => applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId, kind, qtyBase }));
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait };
}
async function blocked(response: Response) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(409);
  expect(body.error).toBe("not_deletable");
  return body.reasons as { code: string; count: number; labels?: string[] }[];
}

beforeEach(async () => {
  scope.role = "operator";
  const tenant = await db.restaurant.create({ data: {
    name: "Permanent delete validation", slug: `permanent-delete-${randomUUID()}`, enabledModules: ["inventory", "purchasing", "recipes"],
  } });
  tenants.push(tenant.id);
  scope.restaurantId = tenant.id;
  orderNumber = 0;
});

afterAll(async () => {
  const where = { restaurantId: { in: tenants } };
  // Las llaves RESTRICT hacia el insumo no dejan caer el comercio en cascada.
  await db.productionBatch.deleteMany({ where });
  await db.purchaseOrder.deleteMany({ where });
  await db.recipe.deleteMany({ where });
  await db.auditEvent.deleteMany({ where });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("eliminar un insumo sin movimientos (PostgreSQL)", () => {
  it("lo elimina con su configuración: códigos, presentaciones, nombres de factura y saldo en cero", async () => {
    const item = await ingredient({ name: "Tomate duplicado", category: "Verduras", barcode: "7700000000015" });
    await db.ingredientBarcode.create({ data: { restaurantId: scope.restaurantId, ingredientId: item.id, barcode: "7700000000022" } });
    const listed = await presentation(item.id);
    await db.supplierInvoiceAlias.create({ data: {
      supplierId: listed.supplierId, ingredientId: item.id, sourceDescription: "TOMATE CHONTO KG", normalizedDescription: "tomate chonto kg",
    } });
    await db.stockLevel.create({ data: { restaurantId: scope.restaurantId, ingredientId: item.id } });

    const before = await check(item.id);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ deletable: true, removes: { barcodes: 2, supplierItems: 1, invoiceAliases: 1 } });

    const response = await remove(item.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, deleted: { id: item.id, name: "Tomate duplicado" } });

    expect(await exists(item.id)).toBe(false);
    expect(await db.ingredientBarcode.count({ where: { ingredientId: item.id } })).toBe(0);
    expect(await db.supplierIngredient.count({ where: { ingredientId: item.id } })).toBe(0);
    expect(await db.supplierInvoiceAlias.count({ where: { ingredientId: item.id } })).toBe(0);
    expect(await db.stockLevel.count({ where: { ingredientId: item.id } })).toBe(0);
    // El proveedor es de otros insumos también: se queda.
    expect(await db.supplier.count({ where: { id: listed.supplierId } })).toBe(1);

    const audit = await db.auditEvent.findMany({ where: { targetId: item.id, kind: "ingredient.delete" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      restaurantId: scope.restaurantId, targetType: "ingredient", summary: "Tomate duplicado", actorRole: "operator",
      diff: { before: {
        name: "Tomate duplicado", category: "Verduras", measureKind: "mass", sku: null, active: true,
        barcodes: ["7700000000015", "7700000000022"], supplierItems: 1, invoiceAliases: 1,
      } },
    });
  });

  it("libera los códigos de barras: el trigger del principal los vuelve a registrar en otro insumo", async () => {
    const junk = await ingredient({ barcode: "7700000000039" });
    await db.ingredientBarcode.create({ data: { restaurantId: scope.restaurantId, ingredientId: junk.id, barcode: "7700000000046" } });
    const real = await ingredient();
    await expect(db.ingredient.update({ where: { id: real.id }, data: { barcode: "7700000000039" } })).rejects.toMatchObject({ code: "P2002" });

    expect((await remove(junk.id)).status).toBe(200);

    await db.ingredient.update({ where: { id: real.id }, data: { barcode: "7700000000039" } });
    await db.ingredientBarcode.create({ data: { restaurantId: scope.restaurantId, ingredientId: real.id, barcode: "7700000000046" } });
    expect((await db.ingredientBarcode.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { barcode: "asc" } }))
      .map((row) => [row.ingredientId, row.barcode])).toEqual([[real.id, "7700000000039"], [real.id, "7700000000046"]]);
  });

  it("elimina también uno archivado, y el DELETE de siempre sigue archivando", async () => {
    const archived = await ingredient({ active: false });
    expect((await remove(archived.id)).status).toBe(200);
    expect(await exists(archived.id)).toBe(false);

    const kept = await ingredient();
    const response = await archiveIngredient(new Request("http://localhost/api/operator/ingredients/x", { method: "DELETE" }), params(kept.id));
    expect(response.status).toBe(200);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: kept.id } })).toMatchObject({ active: false });
  });

  describe("cada referencia lo bloquea y dice por qué", () => {
    const cases: [string, (id: string) => Promise<unknown>, { code: string; count: number; labels?: string[] }[]][] = [
      ["movimientos, aunque el saldo haya vuelto a cero", async (id) => { await move(id, "adjust_in", 500); await move(id, "adjust_out", 500); },
        [{ code: "movements", count: 2 }]],
      ["existencias (cantidad)", (id) => db.stockLevel.create({ data: { restaurantId: scope.restaurantId, ingredientId: id, qtyBase: 250 } }),
        [{ code: "stock", count: 1 }]],
      ["existencias (valor sin cantidad)", (id) => db.stockLevel.create({ data: { restaurantId: scope.restaurantId, ingredientId: id, totalValueCents: -30 } }),
        [{ code: "stock", count: 1 }]],
      ["una orden recibida", (id) => order("received", { ingredientId: id }), [{ code: "purchases", count: 1 }]],
      ["una orden anulada", (id) => order("canceled", { ingredientId: id }), [{ code: "purchases", count: 1 }]],
      ["órdenes en borrador, con su número", async (id) => { await order("draft", { ingredientId: id }); await order("draft", { ingredientId: id }); },
        [{ code: "draftPurchases", count: 2, labels: ["1", "2"] }]],
      ["una orden que usa su presentación con otro insumo", async (id) => {
        const listed = await presentation(id);
        await order("sent", { ingredientId: (await ingredient()).id, supplierItemId: listed.id });
      }, [{ code: "purchases", count: 1 }]],
      ["historial de precios de su presentación", async (id) => {
        const listed = await presentation(id);
        await db.supplierPriceHistory.createMany({ data: [
          { supplierItemId: listed.id, priceCents: 5200, source: "manual" }, { supplierItemId: listed.id, priceCents: 5400, source: "manual" },
        ] });
      }, [{ code: "priceHistory", count: 2 }]],
      ["un lote de producción", (id) => db.productionBatch.create({ data: { restaurantId: scope.restaurantId, outputIngredientId: id, outputQtyBase: 100, costCents: 0 } }),
        [{ code: "production", count: 1 }]],
      ["un conteo cerrado, aunque se haya contado en cero", (id) => db.stockCount.create({ data: {
        restaurantId: scope.restaurantId, status: "closed", closedAt: new Date(), items: { create: [{ ingredientId: id, expectedQty: 0, countedQty: 0 }] },
      } }), [{ code: "closedCounts", count: 1 }]],
      ["la receta de un plato, con su nombre", async (id) => {
        await db.recipeItem.create({ data: { recipeId: (await dish("Bandeja paisa")).id, ingredientId: id, qtyBase: 100 } });
      }, [{ code: "recipes", count: 1, labels: ["Bandeja paisa"] }]],
      ["la sub-receta de otro insumo, con su nombre", async (id) => {
        await db.ingredient.create({ data: {
          restaurantId: scope.restaurantId, name: "Hogao", measureKind: "mass",
          recipe: { create: { restaurantId: scope.restaurantId, outputQtyBase: 1000, items: { create: { ingredientId: id, qtyBase: 100 } } } },
        } });
      }, [{ code: "recipes", count: 1, labels: ["Hogao"] }]],
      ["una opción de modificador", async (id) => {
        await db.modifierRecipeItem.create({ data: { recipeId: (await dish("Arepa")).id, ingredientId: id, modifierId: "extras", optLabel: "Extra queso", qtyBase: 30 } });
      }, [{ code: "modifierRecipes", count: 1, labels: ["Arepa · Extra queso"] }]],
      ["ser él mismo una sub-receta con líneas", async (id) => {
        await db.recipe.create({ data: {
          restaurantId: scope.restaurantId, outputIngredientId: id, outputQtyBase: 1000,
          items: { create: [{ ingredientId: (await ingredient()).id, qtyBase: 100 }, { ingredientId: (await ingredient()).id, qtyBase: 50 }] },
        } });
      }, [{ code: "ownRecipe", count: 2 }]],
    ];

    it.each(cases)("%s", async (_label, arrange, reasons) => {
      const item = await ingredient({ barcode: `B-${randomUUID()}` });
      await arrange(item.id);

      const asked = await check(item.id);
      expect(asked.status).toBe(200);
      expect(await asked.json()).toEqual({ deletable: false, reasons });
      expect(await blocked(await remove(item.id))).toEqual(reasons);

      expect(await exists(item.id)).toBe(true);
      expect(await db.ingredientBarcode.count({ where: { ingredientId: item.id } })).toBe(1);
      expect(await db.auditEvent.count({ where: { targetId: item.id } })).toBe(0);
    });

    it("el conteo en borrador, con su fecha", async () => {
      const item = await ingredient();
      const count = await db.stockCount.create({ data: { restaurantId: scope.restaurantId, items: { create: [{ ingredientId: item.id, expectedQty: 0 }] } } });
      expect(await blocked(await remove(item.id))).toEqual([{ code: "draftCount", count: 1, labels: [count.createdAt.toISOString()] }]);
      expect(await db.stockCountItem.count({ where: { countId: count.id } })).toBe(1);
    });

    it("junta todos los motivos y nombra hasta tres recetas", async () => {
      const item = await ingredient();
      await move(item.id, "adjust_in", 400);
      for (const name of ["Ajiaco", "Bandeja", "Cazuela", "Sancocho"]) {
        await db.recipeItem.create({ data: { recipeId: (await dish(name)).id, ingredientId: item.id, qtyBase: 10 } });
      }
      await order("draft", { ingredientId: item.id });
      expect(await blocked(await remove(item.id))).toEqual([
        { code: "stock", count: 1 },
        { code: "movements", count: 1 },
        { code: "draftPurchases", count: 1, labels: ["1"] },
        { code: "recipes", count: 4, labels: ["Ajiaco", "Bandeja", "Cazuela"] },
      ]);
    });

    it("una sub-receta vacía no bloquea y se va con el insumo", async () => {
      const item = await ingredient();
      const recipe = await db.recipe.create({ data: { restaurantId: scope.restaurantId, outputIngredientId: item.id, outputQtyBase: 1000 } });
      expect((await remove(item.id)).status).toBe(200);
      expect(await db.recipe.count({ where: { id: recipe.id } })).toBe(0);
    });
  });

  describe("permisos y aislamiento entre comercios", () => {
    it.each([null, "mesero", "kitchen", "bar", "terminal"])("rechaza el rol %s sin tocar nada", async (role) => {
      const item = await ingredient();
      scope.role = role;
      for (const response of [await check(item.id), await remove(item.id), await bulk([item.id])]) {
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "unauthorized" });
      }
      expect(await exists(item.id)).toBe(true);
    });

    it("exige alguno de los módulos de insumos", async () => {
      const item = await ingredient();
      await db.restaurant.update({ where: { id: scope.restaurantId }, data: { enabledModules: ["accounting"] } });
      for (const response of [await check(item.id), await remove(item.id), await bulk([item.id])]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "module_disabled" });
      }
      expect(await exists(item.id)).toBe(true);
    });

    it("no ve ni elimina el insumo de otro comercio", async () => {
      const mine = scope.restaurantId;
      const foreignTenant = await db.restaurant.create({ data: { name: "Other", slug: `permanent-delete-other-${randomUUID()}`, enabledModules: ["inventory"] } });
      tenants.push(foreignTenant.id);
      other = foreignTenant.id;
      const foreign = await ingredient({ restaurantId: other, barcode: "OTHER-1" });
      scope.restaurantId = mine;

      expect((await check(foreign.id)).status).toBe(404);
      const response = await remove(foreign.id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect((await bulk([foreign.id])).status).toBe(404);
      expect(await exists(foreign.id)).toBe(true);
      expect(await db.ingredientBarcode.count({ where: { ingredientId: foreign.id } })).toBe(1);
      expect((await remove("no-existe")).status).toBe(404);
    });
  });

  describe("eliminación masiva", () => {
    it("elimina los que se pueden y devuelve los demás con su motivo, intactos", async () => {
      const free = await ingredient({ name: "A libre", barcode: "FREE-1" });
      const archived = await ingredient({ name: "B archivado", active: false });
      const stocked = await ingredient({ name: "C con existencias" });
      await move(stocked.id, "adjust_in", 100);
      const inRecipe = await ingredient({ name: "D en receta" });
      await db.recipeItem.create({ data: { recipeId: (await dish("Ajiaco")).id, ingredientId: inRecipe.id, qtyBase: 10 } });
      const foreignTenant = await db.restaurant.create({ data: { name: "Other", slug: `permanent-delete-bulk-${randomUUID()}`, enabledModules: ["inventory"] } });
      tenants.push(foreignTenant.id);
      const foreign = await ingredient({ restaurantId: foreignTenant.id });

      const response = await bulk([free.id, archived.id, stocked.id, inRecipe.id, foreign.id, free.id]);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        deleted: [{ id: free.id, name: "A libre" }, { id: archived.id, name: "B archivado" }],
        skipped: [
          { id: stocked.id, name: "C con existencias", reasons: [{ code: "stock", count: 1 }, { code: "movements", count: 1 }] },
          { id: inRecipe.id, name: "D en receta", reasons: [{ code: "recipes", count: 1, labels: ["Ajiaco"] }] },
        ],
        missing: [foreign.id],
      });
      expect(await Promise.all([free, archived, stocked, inRecipe, foreign].map((row) => exists(row.id)))).toEqual([false, false, true, true, true]);
      // Los que no se eliminan ni siquiera se archivan.
      expect(await db.ingredient.findUniqueOrThrow({ where: { id: stocked.id } })).toMatchObject({ active: true });
      expect((await db.auditEvent.findMany({ where: { restaurantId: scope.restaurantId, kind: "ingredient.delete" }, orderBy: { summary: "asc" } }))
        .map((event) => event.summary)).toEqual(["A libre", "B archivado"]);
    });

    it.each([[[]], [["a"].concat(Array.from({ length: 200 }, (_, i) => `id-${i}`))], ["ing"], [[1, 2]], [null]])("rechaza un cuerpo inválido: %j", async (ids) => {
      expect((await bulk(ids)).status).toBe(400);
    });
  });

  describe("concurrencia", () => {
    it("vuelve a revisar al eliminar: un movimiento creado después de preguntar lo frena", async () => {
      const item = await ingredient();
      expect(await (await check(item.id)).json()).toMatchObject({ deletable: true });
      await move(item.id, "adjust_in", 300);
      expect(await blocked(await remove(item.id))).toEqual([{ code: "stock", count: 1 }, { code: "movements", count: 1 }]);
      expect(await db.stockMovement.count({ where: { ingredientId: item.id } })).toBe(1);
    });

    it("espera a un movimiento a medio registrar y, cuando se confirma, no elimina", async () => {
      const item = await ingredient();
      const started = gate();
      const finish = gate();
      const moving = db.$transaction(async (tx) => {
        await applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId: item.id, kind: "adjust_in", qtyBase: 700 });
        started.open();
        await finish.wait;
      }, { timeout: 10_000 });
      await started.wait;

      const deleting = remove(item.id);
      let early: string;
      try {
        early = await Promise.race([deleting.then(() => "answered"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 200))]);
      } finally {
        finish.open();
      }
      await moving;
      expect(early).toBe("waiting");
      expect(await blocked(await deleting)).toEqual([{ code: "stock", count: 1 }, { code: "movements", count: 1 }]);
      expect(await db.stockMovement.count({ where: { ingredientId: item.id } })).toBe(1);
      expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: item.id } })).toMatchObject({ qtyBase: 700 });
    });

    it("si otra operación tiene tomado el insumo sin el candado, no espera: lo salta como ocupado", async () => {
      const item = await ingredient();
      const recipe = await dish("Sancocho");
      const started = gate();
      const finish = gate();
      // Un escritor que NO usa el candado de inventario: la fila del insumo
      // queda con FOR KEY SHARE hasta que confirme.
      const inserting = db.$transaction(async (tx) => {
        await tx.recipeItem.create({ data: { recipeId: recipe.id, ingredientId: item.id, qtyBase: 10 } });
        started.open();
        await finish.wait;
      }, { timeout: 10_000 });
      await started.wait;
      let busy: Response;
      try {
        busy = await remove(item.id);
      } finally {
        finish.open();
      }
      await inserting;
      expect(await blocked(busy)).toEqual([{ code: "busy", count: 1 }]);
      expect(await blocked(await remove(item.id))).toEqual([{ code: "recipes", count: 1, labels: ["Sancocho"] }]);
      expect(await db.recipeItem.count({ where: { ingredientId: item.id } })).toBe(1);
    });

    it("mientras se elimina, nadie puede referenciarlo: el movimiento y la línea de receta fallan", async () => {
      const item = await ingredient();
      const recipe = await dish("Mondongo");
      const started = gate();
      const finish = gate();
      const deleting = db.$transaction(async (tx) => {
        const result = await deleteIngredientsPermanently(tx, scope.restaurantId, [item.id]);
        started.open();
        await finish.wait;
        return result;
      }, { timeout: 10_000 });
      await started.wait;

      const movement = move(item.id, "adjust_in", 100).then(() => "created", (error: { code?: string }) => error.code);
      const recipeLine = db.recipeItem.create({ data: { recipeId: recipe.id, ingredientId: item.id, qtyBase: 10 } })
        .then(() => "created", (error: { code?: string }) => error.code);
      let early: string | undefined;
      try {
        early = await Promise.race([movement, recipeLine, new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 200))]);
      } finally {
        finish.open();
      }
      expect(early).toBe("waiting");
      expect((await deleting).deleted.map((row) => row.id)).toEqual([item.id]);
      expect(await movement).toBe("ingredient_not_found");
      expect(await recipeLine).toBe("P2003");
      expect(await exists(item.id)).toBe(false);
      expect(await db.stockMovement.count({ where: { ingredientId: item.id } })).toBe(0);
      expect(await db.recipeItem.count({ where: { recipeId: recipe.id } })).toBe(0);
    });

    it("dos eliminaciones a la vez: una gana y la otra recibe «no existe»", async () => {
      const item = await ingredient();
      const statuses = (await Promise.all([remove(item.id), remove(item.id)])).map((response) => response.status).sort();
      expect(statuses).toEqual([200, 404]);
      expect(await db.auditEvent.count({ where: { targetId: item.id, kind: "ingredient.delete" } })).toBe(1);
    });
  });

  it("la regla se puede consultar sola y no modifica nada", async () => {
    const item = await ingredient({ barcode: "RULE-1" });
    expect(await ingredientDeletionCheck(db, scope.restaurantId, item.id)).toEqual({ deletable: true, removes: { barcodes: 1, supplierItems: 0, invoiceAliases: 0 } });
    expect(await ingredientDeletionCheck(db, scope.restaurantId, "no-existe")).toBeNull();
    expect(await exists(item.id)).toBe(true);
  });
});
