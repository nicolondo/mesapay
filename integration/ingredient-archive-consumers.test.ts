import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { lockStock } from "../src/lib/orderLock";
import { runProduction } from "../src/lib/erp/production";
import { PATCH as updateIngredient, DELETE as deleteIngredient } from "../src/app/api/operator/ingredients/[id]/route";
import { POST as addSupplierIngredient } from "../src/app/api/operator/suppliers/[id]/items/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId }),
  isDenied: () => false,
}));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
let outputId: string;
let inputId: string;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (method: string, payload: unknown) => new Request("http://localhost/api/operator/test", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
});
const archive = (id: string) => updateIngredient(request("PATCH", { active: false }), params(id));
const produce = () => db.$transaction((tx) => runProduction(tx, {
  restaurantId: scope.restaurantId, outputIngredientId: outputId, outputQtyBase: 100,
}));

beforeEach(async () => {
  const tenant = await db.restaurant.create({ data: {
    name: "Archive consumer validation", slug: `archive-consumers-${randomUUID()}`,
    enabledModules: ["inventory", "production", "purchasing", "recipes"],
  } });
  tenants.push(tenant.id);
  scope.restaurantId = tenant.id;
  const input = await db.ingredient.create({ data: {
    restaurantId: tenant.id, name: "Existing recipe input", measureKind: "mass",
    stockLevel: { create: { restaurantId: tenant.id, qtyBase: 1000, totalValueCents: 10000 } },
  } });
  inputId = input.id;
  outputId = (await db.ingredient.create({ data: {
    restaurantId: tenant.id, name: "Production output", measureKind: "mass",
    recipe: { create: {
      restaurantId: tenant.id, outputQtyBase: 100,
      items: { create: { ingredientId: input.id, qtyBase: 200 } },
    } },
  } })).id;
});

afterAll(async () => {
  await db.productionBatch.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.recipe.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("archive guards with PostgreSQL", () => {
  it("keeps existing recipe consumption and production history while preventing new archived output batches", async () => {
    expect((await archive(inputId)).status).toBe(200);
    const result = await produce();
    expect(result).toMatchObject({ batch: { costCents: 2000, outputQtyBase: 100 } });
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: inputId } })).toMatchObject({ qtyBase: 800, totalValueCents: 8000 });
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: outputId } })).toMatchObject({ qtyBase: 100, totalValueCents: 2000 });
    const historical = await db.stockMovement.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { id: "asc" } });

    expect((await archive(outputId)).status).toBe(200);
    await expect(produce()).rejects.toMatchObject({ code: "ingredient_inactive" });

    expect(await db.productionBatch.count({ where: { restaurantId: scope.restaurantId } })).toBe(1);
    expect(await db.stockMovement.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { id: "asc" } })).toEqual(historical);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: outputId } })).toMatchObject({ qtyBase: 100, totalValueCents: 2000 });
  });

  it("retains previous supplier presentations and preferences when rejecting a new archived assignment", async () => {
    const previous = await db.supplier.create({ data: { restaurantId: scope.restaurantId, name: "Previous supplier" } });
    const next = await db.supplier.create({ data: { restaurantId: scope.restaurantId, name: "New supplier" } });
    const item = await db.supplierIngredient.create({ data: {
      supplierId: previous.id, ingredientId: inputId, presentationLabel: "Existing bag", contentQty: 1000, lastPriceCents: 10000, preferred: true,
    } });
    expect((await archive(inputId)).status).toBe(200);

    const response = await addSupplierIngredient(request("POST", {
      ingredientId: inputId, presentationLabel: "New bag", contentQty: 1000, preferred: true,
    }), params(next.id));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ingredient_inactive" });
    expect(await db.supplierIngredient.findMany({ where: { ingredientId: inputId } })).toEqual([item]);
  });

  it("waits for an archive transaction before deciding whether production is allowed", async () => {
    let unlockArchive!: () => void;
    let reportArchived!: () => void;
    const releaseArchive = new Promise<void>((resolve) => { unlockArchive = resolve; });
    const archived = new Promise<void>((resolve) => { reportArchived = resolve; });
    const archiving = db.$transaction(async (tx) => {
      await lockStock(tx, scope.restaurantId);
      await tx.ingredient.update({ where: { id: outputId }, data: { active: false } });
      reportArchived();
      await releaseArchive;
    });
    await archived;
    const production = produce();
    const rejected = expect(production).rejects.toMatchObject({ code: "ingredient_inactive" });
    unlockArchive();
    await archiving;
    await rejected;

    expect(await db.productionBatch.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: inputId } })).toMatchObject({ qtyBase: 1000, totalValueCents: 10000 });
  });

  it("serializes the DELETE archive route with a production transaction and retains its completed batch", async () => {
    let releaseProduction!: () => void;
    let reportLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseProduction = resolve; });
    const locked = new Promise<void>((resolve) => { reportLocked = resolve; });
    const producing = db.$transaction(async (tx) => {
      await lockStock(tx, scope.restaurantId);
      reportLocked();
      await release;
      return runProduction(tx, {
        restaurantId: scope.restaurantId, outputIngredientId: outputId, outputQtyBase: 100,
      });
    });
    await locked;
    const deleting = deleteIngredient(new Request("http://localhost/api/operator/ingredients/output", { method: "DELETE" }), params(outputId));
    let beforeRelease: string;
    try {
      beforeRelease = await Promise.race([
        deleting.then(() => "archived"),
        new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
      ]);
    } finally {
      releaseProduction();
    }
    const [production, response] = await Promise.allSettled([producing, deleting]);
    expect(beforeRelease).toBe("waiting");
    expect(production.status).toBe("fulfilled");
    expect(response.status).toBe("fulfilled");
    if (response.status !== "fulfilled") throw response.reason;
    expect(response.value.status).toBe(200);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: outputId } })).toMatchObject({ active: false });
    expect(await db.productionBatch.count({ where: { restaurantId: scope.restaurantId } })).toBe(1);
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(2);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: outputId } })).toMatchObject({ qtyBase: 100, totalValueCents: 2000 });
  });
});
