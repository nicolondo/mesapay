import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { lockStock } from "../src/lib/orderLock";
import { PUT as saveDish } from "../src/app/api/operator/recipes/dish/[menuItemId]/route";
import { PUT as saveSub, DELETE as deleteSub } from "../src/app/api/operator/recipes/sub/[ingredientId]/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
// Only authentication is substituted: validation, locks, recipe graph checks,
// transactions and persistence run against isolated PostgreSQL.
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId, country: "CO" }),
  isDenied: () => false,
}));

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
let categoryId: string;
const line = (ingredientId: string, qtyBase = 100) => ({ ingredientId, qtyBase, wastePct: 0 });
const request = (path: string, data: unknown) => new Request(`http://localhost/api/operator/recipes/${path}`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(data),
});
const ingredient = (restaurantId = tenants[0], active = true) => db.ingredient.create({
  data: { restaurantId, name: `Archive recipe ${randomUUID()}`, measureKind: "mass", active },
});

async function target(kind: "dish" | "sub", ingredientIds: string[]) {
  const owner = kind === "dish"
    ? await db.menuItem.create({ data: {
      restaurantId: tenants[0], categoryId, name: `Archive dish ${randomUUID()}`, priceCents: 1000,
      modifiers: [{ id: "extras", label: "Extras", type: "checkbox", opts: ["Original", "Other"] }],
    } })
    : await ingredient();
  const recipe = await db.recipe.create({ data: {
    restaurantId: tenants[0],
    ...(kind === "dish" ? { menuItemId: owner.id } : { outputIngredientId: owner.id, outputQtyBase: 1000 }),
    notes: "Original notes",
    items: { create: ingredientIds.map((id) => line(id)) },
  } });
  return {
    id: owner.id,
    recipeId: recipe.id,
    save: (data: Record<string, unknown>) => kind === "dish"
      ? saveDish(request(`dish/${owner.id}`, data), { params: Promise.resolve({ menuItemId: owner.id }) })
      : saveSub(request(`sub/${owner.id}`, { outputQtyBase: 1000, ...data }), { params: Promise.resolve({ ingredientId: owner.id }) }),
    read: () => db.recipe.findUniqueOrThrow({
      where: { id: recipe.id },
      include: { items: { orderBy: { id: "asc" } }, modifierItems: { orderBy: { id: "asc" } } },
    }),
  };
}

beforeAll(async () => {
  for (let i = 0; i < 2; i++) {
    const restaurant = await db.restaurant.create({ data: {
      name: "Ingredient archive recipe validation", slug: `archive-recipes-${randomUUID()}`, enabledModules: ["recipes"],
    } });
    tenants.push(restaurant.id);
  }
  scope.restaurantId = tenants[0];
  categoryId = (await db.category.create({ data: { restaurantId: tenants[0], label: "Validation", slug: "validation" } })).id;
});

afterAll(async () => {
  await db.recipe.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe.each(["dish", "sub"] as const)("archived ingredient references in %s recipes", (kind) => {
  it("retains an existing archived input when changing quantities and notes", async () => {
    const input = await ingredient();
    const recipe = await target(kind, [input.id]);
    await db.ingredient.update({ where: { id: input.id }, data: { active: false } });

    const response = await recipe.save({ items: [line(input.id, 250)], notes: "Revised notes" });

    expect(response.status).toBe(200);
    expect((await response.json()).recipe).toMatchObject({ notes: "Revised notes", items: [line(input.id, 250)] });
    expect(await recipe.read()).toMatchObject({ notes: "Revised notes", items: [line(input.id, 250)] });
    expect((await db.ingredient.findUniqueOrThrow({ where: { id: input.id } })).active).toBe(false);
  });

  it("does not allow a new archived input just because another recipe uses it", async () => {
    const current = await ingredient();
    const archived = await ingredient();
    await target(kind, [archived.id]);
    await db.ingredient.update({ where: { id: archived.id }, data: { active: false } });
    const recipe = await target(kind, [current.id]);
    const before = await recipe.read();

    const response = await recipe.save({ items: [line(current.id, 300), line(archived.id)], notes: "Must not save" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ingredient_not_found" });
    expect(await recipe.read()).toEqual(before);
  });

  it.each([true, false])("rejects a foreign ingredient even when already referenced (active=%s)", async (active) => {
    const foreign = await ingredient(tenants[1], active);
    // A legacy invalid cross-tenant reference must never grant new permission.
    const recipe = await target(kind, [foreign.id]);
    const before = await recipe.read();

    const response = await recipe.save({ items: [line(foreign.id, 200)] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ingredient_not_found" });
    expect(await recipe.read()).toEqual(before);
  });

  it("allows removing an archived input but refuses to add it back afterwards", async () => {
    const current = await ingredient();
    const archived = await ingredient();
    const recipe = await target(kind, [current.id, archived.id]);
    await db.ingredient.update({ where: { id: archived.id }, data: { active: false } });

    expect((await recipe.save({ items: [line(current.id)] })).status).toBe(200);
    const afterRemoval = await recipe.read();
    expect(afterRemoval.items).toHaveLength(1);
    expect((await recipe.save({ items: [line(current.id), line(archived.id)] })).status).toBe(400);
    expect(await recipe.read()).toEqual(afterRemoval);
  });

  it("still allows adding active inputs and rejects recipe edits across tenants", async () => {
    const current = await ingredient();
    const added = await ingredient();
    const recipe = await target(kind, [current.id]);
    expect((await recipe.save({ items: [line(current.id), line(added.id)] })).status).toBe(200);
    const before = await recipe.read();
    scope.restaurantId = tenants[1];
    try {
      expect((await recipe.save({ items: [line(added.id)] })).status).toBe(404);
    } finally {
      scope.restaurantId = tenants[0];
    }
    expect(await recipe.read()).toEqual(before);
  });

  it("waits for an in-progress archive before validating a newly added input", async () => {
    const current = await ingredient();
    const added = await ingredient();
    const recipe = await target(kind, [current.id]);
    const before = await recipe.read();
    let releaseArchive!: () => void;
    let signalLocked!: () => void;
    const holdArchive = new Promise<void>((resolve) => { releaseArchive = resolve; });
    const archiveLocked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const archive = db.$transaction(async (tx) => {
      await lockStock(tx, tenants[0]);
      await tx.ingredient.update({ where: { id: added.id }, data: { active: false } });
      signalLocked();
      await holdArchive;
    });
    await archiveLocked;
    const saving = recipe.save({ items: [line(current.id), line(added.id)] });
    try {
      // Observe the real PostgreSQL wait instead of relying on timing/sleeps.
      await vi.waitFor(async () => {
        const locks = await db.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND objid = 731
            AND classid::bigint = (hashtext(${tenants[0]})::bigint & 4294967295)
        `;
        expect(locks[0].count).toBeGreaterThan(0);
      });
    } finally {
      releaseArchive();
      await archive;
    }
    const response = await saving;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ingredient_not_found" });
    expect(await recipe.read()).toEqual(before);
  });
});

describe("archived modifier references and recipe deletion", () => {
  it("retains an archived modifier input when updating the dish recipe", async () => {
    const base = await ingredient();
    const extra = await ingredient();
    const recipe = await target("dish", [base.id]);
    await db.modifierRecipeItem.create({ data: {
      recipeId: recipe.recipeId, modifierId: "extras", optLabel: "Original", ...line(extra.id),
    } });
    await db.ingredient.update({ where: { id: extra.id }, data: { active: false } });
    const modifierItems = [{ modifierId: "extras", optLabel: "Original", ...line(extra.id, 200) }];

    const response = await recipe.save({ items: [line(base.id)], modifierItems });

    expect(response.status).toBe(200);
    expect((await response.json()).recipe.modifierItems).toEqual(modifierItems);
    expect((await recipe.read()).modifierItems).toMatchObject(modifierItems);
  });

  it("rejects a newly added archived modifier without replacing the recipe", async () => {
    const base = await ingredient();
    const extra = await ingredient(tenants[0], false);
    const recipe = await target("dish", [base.id]);
    const before = await recipe.read();

    const response = await recipe.save({
      items: [line(base.id, 200)],
      modifierItems: [{ modifierId: "extras", optLabel: "Original", ...line(extra.id) }],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ingredient_not_found" });
    expect(await recipe.read()).toEqual(before);
  });

  it.each(["dish", "sub"] as const)("deletes a %s recipe with archived inputs without deleting its ingredients", async (kind) => {
    const input = await ingredient(tenants[0], false);
    const recipe = await target(kind, [input.id]);
    const response = kind === "dish"
      ? await recipe.save({ items: [] })
      : await deleteSub(new Request(`http://localhost/api/operator/recipes/sub/${recipe.id}`, { method: "DELETE" }), { params: Promise.resolve({ ingredientId: recipe.id }) });

    expect(response.status).toBe(200);
    expect(await db.recipe.findUnique({ where: { id: recipe.recipeId } })).toBeNull();
    expect(await db.ingredient.findUnique({ where: { id: input.id } })).toMatchObject({ active: false });
  });
});
