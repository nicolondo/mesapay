import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/lib/db";
import { GET as catalog, POST as createIngredient } from "../src/app/api/operator/ingredients/route";
import { PATCH as updateIngredient } from "../src/app/api/operator/ingredients/[id]/route";
import { GET as stock } from "../src/app/api/operator/stock/route";
import { POST as createCount } from "../src/app/api/operator/stock/counts/route";
import { GET as readCount } from "../src/app/api/operator/stock/counts/[id]/route";

const scope = vi.hoisted(() => ({ restaurantId: "", staleBarcodeLookup: false }));
vi.mock("../src/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/db")>();
  return {
    ...actual,
    db: actual.db.$extends({
      query: {
        ingredientBarcode: {
          findUnique({ args, query }) {
            if (scope.staleBarcodeLookup) {
              scope.staleBarcodeLookup = false;
              return Promise.resolve(null);
            }
            return query(args);
          },
        },
      },
    }),
  };
});
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: scope.restaurantId, userId: null }),
  isDenied: () => false,
}));
vi.mock("../src/auth", () => ({ auth: async () => null }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
const request = (payload: unknown = {}) => new Request("http://localhost/api/operator/ingredients", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const edit = (id: string, barcode: string | null) => updateIngredient(request({ barcode }), params(id));
const make = (name: string, barcode: string | null = null, restaurantId = scope.restaurantId) => db.ingredient.create({
  data: { restaurantId, name, barcode, measureKind: "count" },
});
const alias = (ingredientId: string, barcode: string) => db.ingredientBarcode.create({
  data: { restaurantId: scope.restaurantId, ingredientId, barcode },
});

beforeEach(async () => {
  scope.staleBarcodeLookup = false;
  const restaurant = await db.restaurant.create({ data: {
    name: "Barcode compatibility validation", slug: `barcode-compat-${randomUUID()}`, enabledModules: ["inventory"],
  } });
  scope.restaurantId = restaurant.id;
  tenants.push(restaurant.id);
});

afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("existing ingredient API with a canonical barcode registry", () => {
  it("blocks a code already held as an alias without changing either ingredient", async () => {
    const owner = await make("Alias owner", "00123");
    const other = await make("Other", "00456");
    await alias(owner.id, "00ALIAS");
    const before = await db.ingredient.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { id: "asc" } });

    const created = await createIngredient(request({ name: "New", measureKind: "count", barcode: "00 ALIAS\r\n" }));
    const updated = await edit(other.id, "00ALIAS");

    expect(created.status).toBe(409);
    expect(await created.json()).toEqual({ error: "barcode_taken" });
    expect(updated.status).toBe(409);
    expect(await updated.json()).toEqual({ error: "barcode_taken" });
    expect(await db.ingredient.findMany({ where: { restaurantId: scope.restaurantId }, orderBy: { id: "asc" } })).toEqual(before);
  });

  it("promotes or clears the primary while keeping the other additional codes", async () => {
    const ingredient = await make("Own aliases", "PRIMARY");
    await alias(ingredient.id, "00ab");
    await alias(ingredient.id, "EXTRA");

    expect((await edit(ingredient.id, " 00ab\r\n")).status).toBe(200);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).toMatchObject({ barcode: "00ab" });
    expect(await db.ingredientBarcode.findMany({ where: { ingredientId: ingredient.id }, select: { barcode: true }, orderBy: { barcode: "asc" } })).toEqual([{ barcode: "00ab" }, { barcode: "EXTRA" }]);

    expect((await edit(ingredient.id, null)).status).toBe(200);
    expect(await db.ingredientBarcode.findMany({ where: { ingredientId: ingredient.id }, select: { barcode: true } })).toEqual([{ barcode: "EXTRA" }]);
  });

  it("permits the same code at a different restaurant", async () => {
    const other = await db.restaurant.create({ data: { name: "Other tenant", slug: `barcode-other-${randomUUID()}` } });
    tenants.push(other.id);
    await make("Other tenant ingredient", "00ab", other.id);
    const response = await createIngredient(request({ name: "Own ingredient", measureKind: "count", barcode: "00ab" }));
    expect(response.status).toBe(201);
    const ingredient = (await response.json()).ingredient;
    expect(await db.ingredientBarcode.findUnique({ where: { restaurantId_barcode: { restaurantId: scope.restaurantId, barcode: "00ab" } } })).toMatchObject({ ingredientId: ingredient.id });
  });

  it.each(["create", "update"])("turns a real trigger collision after a stale %s preflight into barcode_taken", async (kind) => {
    const owner = await make("Owner", "PRIMARY");
    const other = await make("Other", "OTHER");
    await alias(owner.id, "ALIAS");
    scope.staleBarcodeLookup = true;

    const response = kind === "create"
      ? await createIngredient(request({ name: "New", measureKind: "count", barcode: "ALIAS" }))
      : await edit(other.id, "ALIAS");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "barcode_taken" });
    expect(await db.ingredient.count({ where: { restaurantId: scope.restaurantId } })).toBe(2);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: other.id } })).toMatchObject({ barcode: "OTHER" });
    expect(await db.ingredientBarcode.findUnique({ where: { restaurantId_barcode: { restaurantId: scope.restaurantId, barcode: "OTHER" } } })).toMatchObject({ ingredientId: other.id });
  });

  it("receives Prisma barcode metadata from the SQL trigger constraint", async () => {
    const owner = await make("Metadata owner");
    const other = await make("Metadata other");
    await alias(owner.id, "ALIAS");
    const error = await db.ingredient.update({ where: { id: other.id }, data: { barcode: "ALIAS" } }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error).toMatchObject({ code: "P2002", meta: { target: ["restaurantId", "barcode"] } });
  });
});

describe("all stock read paths expose additional codes", () => {
  it("includes aliases in catalog, stock, newly opened and reopened counts", async () => {
    const ingredient = await make("Multiple codes", "00123");
    await alias(ingredient.id, "00ab");
    const expectedCodes = [{ barcode: "00123" }, { barcode: "00ab" }];

    const catalogResponse = await catalog(request());
    const stockResponse = await stock(request());
    expect((await catalogResponse.json()).ingredients[0]).toMatchObject({ id: ingredient.id, barcode: "00123", barcodes: expectedCodes });
    expect((await stockResponse.json()).stock[0]).toMatchObject({ id: ingredient.id, barcode: "00123", barcodes: expectedCodes });

    const createdResponse = await createCount(request());
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()).count;
    expect(created.items[0].ingredient).toMatchObject({ id: ingredient.id, barcode: "00123", barcodes: expectedCodes });
    const reloaded = (await (await readCount(request(), params(created.id))).json()).count;
    expect(reloaded.items[0].ingredient).toMatchObject({ id: ingredient.id, barcode: "00123", barcodes: expectedCodes });
  });
});
