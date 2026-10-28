import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { mutateStockCount, type StockCountInput } from "../src/lib/erp/stockCounts";
import { POST as create } from "../src/app/api/operator/stock/counts/route";
import { GET as get, PATCH as patch } from "../src/app/api/operator/stock/counts/[id]/route";
import { POST as preliminary } from "../src/app/api/operator/stock/counts/[id]/preliminary/route";
import { POST as recount } from "../src/app/api/operator/stock/counts/[id]/recount/route";
import { POST as review } from "../src/app/api/operator/stock/counts/[id]/review/route";
import { POST as close } from "../src/app/api/operator/stock/counts/[id]/close/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({ getErpContext: async () => ({ restaurantId: scope.restaurantId, country: "CO" }), isDenied: () => false }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) throw new Error("Isolated local database required");

type Item = { id: string; ingredientId: string; countedQty: number | null; countedParts: number[]; preliminaryQty: number | null; preliminaryParts: number[] };
type Count = { id: string; revision: number; status: string; finalReview: { token: string } | null; items: Item[] };
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const tenants: string[] = [];
let a: string;
let b: string;
const request = (method: string, data?: unknown) => new Request("http://localhost/api/operator/stock/counts", { method, headers: { "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const call = (handler: Handler, count: Count, data: Record<string, unknown> = {}, method = "POST") => handler(request(method, { revision: count.revision, ...data }), { params: Promise.resolve({ id: count.id }) });
async function success(response: Response, status = 200): Promise<Count> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body).toHaveProperty("count");
  return body.count;
}
const item = (count: Count, ingredientId = a) => count.items.find((entry) => entry.ingredientId === ingredientId)!;
async function start() { return success(await create(request("POST", {})), 201); }
async function save(count: Count, parts: [number[], number[]] = [[12_000, 3_000, 5_000], [0]]) {
  return success(await call(patch, count, { items: count.items.map((entry) => {
    const countedParts = parts[entry.ingredientId === a ? 0 : 1];
    return { itemId: entry.id, countedQty: countedParts.length ? countedParts.reduce((sum, qty) => sum + qty, 0) : null, countedParts };
  }) }, "PATCH"));
}
const stock = (ingredientId: string) => db.stockLevel.findUniqueOrThrow({ where: { ingredientId } });

beforeEach(async () => {
  const restaurant = await db.restaurant.create({ data: { name: "Conteos parciales validación", slug: `count-parts-${randomUUID()}`, enabledModules: ["inventory"] } });
  tenants.push(restaurant.id); scope.restaurantId = restaurant.id;
  a = (await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Agua", measureKind: "count", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 25_000, totalValueCents: 250_000 } } } })).id;
  b = (await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Arroz", measureKind: "mass", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 5_000, totalValueCents: 50_000 } } } })).id;
});
afterAll(async () => { await db.restaurant.deleteMany({ where: { id: { in: tenants } } }); await db.$disconnect(); });

describe("persisted stock count scan parts", () => {
  it("preserves multiple scans through reopening, preliminary, recount, review and final closure", async () => {
    let count = await save(await start());
    expect(item(count)).toMatchObject({ countedQty: 20_000, countedParts: [12_000, 3_000, 5_000], preliminaryParts: [] });
    count = await success(await get(request("GET"), { params: Promise.resolve({ id: count.id }) }));
    expect(item(count).countedParts).toEqual([12_000, 3_000, 5_000]);
    expect((await stock(a)).qtyBase).toBe(25_000);
    count = await success(await call(preliminary, count));
    expect(item(count)).toMatchObject({ preliminaryQty: 20_000, preliminaryParts: [12_000, 3_000, 5_000] });
    expect((await call(patch, count, { items: [{ itemId: item(count).id, countedQty: 1, countedParts: [1] }] }, "PATCH")).status).toBe(409);
    count = await success(await call(recount, count));
    expect(item(count)).toMatchObject({ countedQty: null, countedParts: [], preliminaryQty: 20_000, preliminaryParts: [12_000, 3_000, 5_000] });
    count = await save(count, [[5_000, 500], [0]]);
    count = await success(await call(review, count));
    expect((await stock(a)).qtyBase).toBe(25_000);
    expect(await db.stockMovement.count({ where: { stockCountId: count.id } })).toBe(0);
    const reviewed = count;
    count = await success(await call(close, count, { reviewToken: count.finalReview!.token }));
    expect(count.status).toBe("closed");
    expect(item(count)).toMatchObject({ countedQty: 5_500, countedParts: [5_000, 500], preliminaryQty: 20_000, preliminaryParts: [12_000, 3_000, 5_000] });
    expect((await stock(a)).qtyBase).toBe(5_500); expect((await stock(b)).qtyBase).toBe(0);
    expect(await db.stockMovement.count({ where: { stockCountId: count.id } })).toBe(2);
    expect((await call(close, reviewed, { reviewToken: reviewed.finalReview!.token })).status).toBe(409);
    expect((await call(patch, count, { items: [{ itemId: item(count).id, countedQty: 1, countedParts: [1] }] }, "PATCH")).status).toBe(409);
  });

  it("distinguishes a zero scan from an uncounted ingredient", async () => {
    const count = await save(await start(), [[0], []]);
    expect(item(count)).toMatchObject({ countedQty: 0, countedParts: [0] });
    expect(item(count, b)).toMatchObject({ countedQty: null, countedParts: [] });
    const frozen = await success(await call(preliminary, count));
    expect(item(frozen).preliminaryParts).toEqual([0]);
    expect(item(frozen, b).preliminaryParts).toEqual([]);
  });

  it("retains valid scan breakdowns for unchanged legacy saves and collapses changed legacy totals", async () => {
    let count = await save(await start());
    count = await success(await call(patch, count, { items: [{ itemId: item(count).id, countedQty: 20_000 }] }, "PATCH"));
    expect(item(count).countedParts).toEqual([12_000, 3_000, 5_000]);
    count = await success(await call(patch, count, { items: [{ itemId: item(count).id, countedQty: 7_000 }] }, "PATCH"));
    expect(item(count).countedParts).toEqual([7_000]);
    count = await success(await call(patch, count, { items: [{ itemId: item(count).id, countedQty: null }] }, "PATCH"));
    expect(item(count).countedParts).toEqual([]);
  });

  it("freezes legacy or old-version totals with a normalized preliminary breakdown", async () => {
    let count = await save(await start());
    // An older process can update only countedQty while the new columns remain.
    await db.stockCountItem.update({ where: { id: item(count).id }, data: { countedQty: 8_000 } });
    count = await success(await call(preliminary, count));
    expect(item(count)).toMatchObject({ countedQty: 8_000, preliminaryQty: 8_000, preliminaryParts: [8_000] });
  });

  it("allows 200 parts at the quantity boundary", async () => {
    const count = await save(await start(), [Array.from({ length: 200 }, () => 10_000_000), [0]]);
    expect(item(count)).toMatchObject({ countedQty: 2_000_000_000 });
    expect(item(count).countedParts).toHaveLength(200);
  });

  it("rejects malformed parts and mismatched totals atomically at the API boundary", async () => {
    const count = await save(await start());
    const invalid = [
      { countedQty: 10, countedParts: [9] }, { countedQty: 10, countedParts: [] },
      { countedQty: 0, countedParts: [] }, { countedQty: null, countedParts: [0] },
      { countedQty: 10, countedParts: [-1, 11] }, { countedQty: 10, countedParts: [10.5] },
      { countedQty: 10, countedParts: ["10"] }, { countedQty: 10, countedParts: [null] },
      { countedQty: 10, countedParts: null }, { countedQty: 10, countedParts: "10" },
      { countedQty: 201, countedParts: Array.from({ length: 201 }, () => 1) },
      { countedQty: 2_000_000_000, countedParts: [2_000_000_000, 1] },
    ];
    for (const bad of invalid) {
      const response = await call(patch, count, { items: [{ itemId: item(count).id, countedQty: 1, countedParts: [1] }, { itemId: item(count, b).id, ...bad }] }, "PATCH");
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(await response.json()).toMatchObject({ error: "qty_invalid" });
    }
    expect(await db.stockCount.findUniqueOrThrow({ where: { id: count.id } })).toMatchObject({ revision: count.revision });
    expect(await db.stockCountItem.findUniqueOrThrow({ where: { id: item(count).id } })).toMatchObject({ countedQty: 20_000, countedParts: [12_000, 3_000, 5_000] });
    expect(await db.stockMovement.count({ where: { stockCountId: count.id } })).toBe(0);
  });

  it("validates quantities and parts independently for non-HTTP callers", async () => {
    const count = await save(await start());
    const invalid = [
      { countedQty: -1 }, { countedQty: 1.5 }, { countedQty: NaN }, { countedQty: Infinity },
      { countedQty: undefined }, { countedQty: 2_000_000_001 },
      { countedQty: 10, countedParts: [9] }, { countedQty: 10, countedParts: [NaN] },
      { countedQty: 0, countedParts: [] }, { countedQty: null, countedParts: [0] },
      { countedQty: 10, countedParts: new Array(1) },
      { countedQty: 201, countedParts: Array.from({ length: 201 }, () => 1) },
    ];
    for (const bad of invalid) {
      const input = { revision: count.revision, items: [{ itemId: item(count).id, countedQty: 1, countedParts: [1] }, { itemId: item(count, b).id, ...bad }] } as unknown as StockCountInput;
      await expect(mutateStockCount(scope.restaurantId, count.id, "save", input)).rejects.toMatchObject({ code: "qty_invalid", status: 400 });
    }
    expect(await db.stockCount.findUniqueOrThrow({ where: { id: count.id } })).toMatchObject({ revision: count.revision });
    expect(await db.stockCountItem.findUniqueOrThrow({ where: { id: item(count).id } })).toMatchObject({ countedQty: 20_000, countedParts: [12_000, 3_000, 5_000] });
  });

  it("rejects stale revisions, foreign item IDs and cross-tenant part edits", async () => {
    const original = await start();
    const count = await save(original);
    const payload = { items: [{ itemId: item(count).id, countedQty: 1, countedParts: [1] }] };
    expect((await call(patch, original, payload, "PATCH")).status).toBe(409);
    expect((await call(patch, count, { items: [{ itemId: "foreign-item", countedQty: 1, countedParts: [1] }] }, "PATCH")).status).toBe(400);
    const foreign = await db.restaurant.create({ data: { name: "Otro comercio", slug: `count-parts-foreign-${randomUUID()}` } });
    tenants.push(foreign.id); scope.restaurantId = foreign.id;
    expect((await call(patch, count, payload, "PATCH")).status).toBe(404);
    expect(await db.stockCountItem.findUniqueOrThrow({ where: { id: item(count).id } })).toMatchObject({ countedQty: 20_000, countedParts: [12_000, 3_000, 5_000] });
  });
});
