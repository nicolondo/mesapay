import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { applyStockMovement } from "../src/lib/erp/stock";
import { POST as create } from "../src/app/api/operator/stock/counts/route";
import { GET as get, PATCH as patch, DELETE as remove } from "../src/app/api/operator/stock/counts/[id]/route";
import { POST as preliminary } from "../src/app/api/operator/stock/counts/[id]/preliminary/route";
import { POST as recount } from "../src/app/api/operator/stock/counts/[id]/recount/route";
import { POST as review } from "../src/app/api/operator/stock/counts/[id]/review/route";
import { POST as close } from "../src/app/api/operator/stock/counts/[id]/close/route";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
// Real route validation, stock locking and PostgreSQL. Real login/guards are
// exercised separately by the browser tests.
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({ getErpContext: async () => ({ restaurantId: scope.restaurantId, country: "CO" }), isDenied: () => false }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) throw new Error("Isolated local database required");
type Count = { id: string; revision: number; status: string; preliminaryAt: string | null; recountStartedAt: string | null; finalReview: { token: string } | null; items: { id: string; ingredientId: string; expectedQty: number; countedQty: number | null; preliminaryQty: number | null; finalExpectedQty: number | null }[] };
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const tenants: string[] = [];
let a: string, b: string, excluded: string;
const request = (method: string, data?: unknown) => new Request("http://localhost/api/operator/stock/counts", { method, headers: { "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const call = (handler: Handler, count: Count, data: Record<string, unknown> = {}, method = "POST") => handler(request(method, { revision: count.revision, ...data }), { params: Promise.resolve({ id: count.id }) });
async function success(response: Response, status = 200): Promise<Count> { const body = await response.json(); expect(body, `HTTP ${response.status}`).toHaveProperty("count"); expect(response.status).toBe(status); return body.count; }
async function start() { return success(await create(request("POST", {})), 201); }
async function save(count: Count, quantities: [number | null, number | null]) { return success(await call(patch, count, { items: count.items.map((item) => ({ itemId: item.id, countedQty: quantities[item.ingredientId === a ? 0 : 1] })) }, "PATCH")); }
async function ready(quantities: [number, number] = [8000, 0]) { let count = await save(await start(), [7000, 6000]); count = await success(await call(preliminary, count)); count = await success(await call(recount, count)); count = await save(count, quantities); return success(await call(review, count)); }
async function move(ingredientId: string, qtyBase: number, kind: "adjust_in" | "sale_consumption" = "sale_consumption") { return db.$transaction((tx) => applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId, qtyBase, kind })); }
const balance = async (ingredientId: string) => (await db.stockLevel.findUniqueOrThrow({ where: { ingredientId } })).qtyBase;
const adjustments = (count: Count) => db.stockMovement.findMany({ where: { stockCountId: count.id } });

beforeEach(async () => {
  const restaurant = await db.restaurant.create({ data: { name: "Conteo validación", slug: `count-${randomUUID()}`, enabledModules: ["inventory"] } });
  tenants.push(restaurant.id); scope.restaurantId = restaurant.id;
  a = (await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Arroz", measureKind: "mass", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 10000, totalValueCents: 100000 } } } })).id;
  b = (await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Leche", measureKind: "volume", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: 5000, totalValueCents: 50000 } } } })).id;
  excluded = (await db.ingredient.create({ data: { restaurantId: restaurant.id, name: "Servicio", measureKind: "count", trackInventory: false } })).id;
});
afterAll(async () => { await db.restaurant.deleteMany({ where: { id: { in: tenants } } }); await db.$disconnect(); });

describe("preliminary and definitive stock counts on PostgreSQL", () => {
  it("preserves the first count, uses stock at recount start, and adjusts exactly once only after confirmation", async () => {
    let count = await start();
    expect(count.items.map((item) => item.ingredientId)).not.toContain(excluded);
    count = await save(count, [7000, 6000]);
    count = await success(await call(preliminary, count));
    expect(count.preliminaryAt).not.toBeNull();
    expect(await balance(a)).toBe(10000); expect(await balance(b)).toBe(5000); expect(await adjustments(count)).toHaveLength(0);
    await move(a, 2000);
    count = await success(await call(recount, count));
    expect(count.items.find((item) => item.ingredientId === a)).toMatchObject({ expectedQty: 10000, preliminaryQty: 7000, finalExpectedQty: 8000, countedQty: null });
    expect(count.items.find((item) => item.ingredientId === b)).toMatchObject({ preliminaryQty: 6000, countedQty: null });
    count = await save(count, [9000, 0]);
    count = await success(await call(review, count));
    expect(await balance(a)).toBe(8000); expect(await balance(b)).toBe(5000); expect(await adjustments(count)).toHaveLength(0);
    const approved = count;
    count = await success(await call(close, count, { reviewToken: count.finalReview?.token }));
    expect(count.status).toBe("closed"); expect(await balance(a)).toBe(9000); expect(await balance(b)).toBe(0);
    expect((await adjustments(count)).map((row) => row.qtyBase).sort((x, y) => x - y)).toEqual([-5000, 1000]);
    expect(count.items.find((item) => item.ingredientId === a)?.preliminaryQty).toBe(7000);
    expect((await call(close, approved, { reviewToken: approved.finalReview?.token })).status).toBe(409);
    expect(await adjustments(count)).toHaveLength(2);
  });

  it("does not treat uncounted ingredients as zero and blocks direct close", async () => {
    let count = await save(await start(), [7000, null]);
    expect((await call(close, count)).status).toBeGreaterThanOrEqual(400);
    count = await success(await call(preliminary, count));
    count = await success(await call(recount, count));
    count = await save(count, [8000, null]);
    const response = await call(review, count); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: "incomplete_count" });
    expect(await balance(b)).toBe(5000); expect(await adjustments(count)).toHaveLength(0);
  });

  it("requires an explicit new recount after movement, including an out-and-back movement after review", async () => {
    let count = await ready();
    await move(a, 1000); await move(a, 1000, "adjust_in");
    expect(await balance(a)).toBe(10000);
    for (const handler of [review, close]) {
      const response = await call(handler, count, { reviewToken: count.finalReview?.token });
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "stock_changed" });
    }
    expect(await adjustments(count)).toHaveLength(0);
    count = await success(await call(recount, count));
    expect(count.items.every((item) => item.countedQty === null)).toBe(true);
    count = await save(count, [8500, 0]); count = await success(await call(review, count));
    count = await success(await call(close, count, { reviewToken: count.finalReview?.token }));
    expect(await balance(a)).toBe(8500); expect(await balance(b)).toBe(0);
  });

  it("detects a sale during definitive counting before review", async () => {
    let count = await save(await start(), [7000, 6000]);
    count = await success(await call(preliminary, count)); count = await success(await call(recount, count));
    await move(a, 1000);
    count = await save(count, [8500, 5000]);
    const response = await call(review, count);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "stock_changed" });
    expect(await balance(a)).toBe(9000); expect(await adjustments(count)).toHaveLength(0);
  });

  it("requires the current review token and revision when confirming or deleting", async () => {
    const count = await ready();
    const forged = await call(close, count, { reviewToken: randomUUID() });
    expect(forged.status).toBe(409); expect(await forged.json()).toMatchObject({ error: "review_required" });
    const missingRevision = await remove(request("DELETE", {}), { params: Promise.resolve({ id: count.id }) });
    expect(missingRevision.status).toBe(400);
    expect(await adjustments(count)).toHaveLength(0);
    expect((await call(remove, count, {}, "DELETE")).status).toBe(200);
    expect(await db.stockCount.findUnique({ where: { id: count.id } })).toBeNull();
    expect(await balance(a)).toBe(10000);
  });

  it("invalidates review when final quantities are changed and rejects stale revisions", async () => {
    const old = await ready(); const updated = await save(old, [6000, 0]);
    expect(updated.finalReview).toBeNull();
    for (const handler of [review, recount, close, remove]) {
      const response = await call(handler, old, { reviewToken: old.finalReview?.token }, handler === remove ? "DELETE" : "POST");
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "count_changed" });
    }
    expect(await adjustments(updated)).toHaveLength(0); expect(await balance(a)).toBe(10000);
  });

  it("serializes simultaneous creates and double close requests", async () => {
    const results = await Promise.all([create(request("POST", {})), create(request("POST", {}))]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    let count = await success(results.find((response) => response.status === 201)!, 201);
    count = await save(count, [8000, 0]); count = await success(await call(preliminary, count)); count = await success(await call(recount, count)); count = await save(count, [8000, 0]); count = await success(await call(review, count));
    const closed = await Promise.all([call(close, count, { reviewToken: count.finalReview?.token }), call(close, count, { reviewToken: count.finalReview?.token })]);
    expect(closed.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await adjustments(count)).toHaveLength(2); expect(await balance(a)).toBe(8000);
  });

  it("serializes a concurrent edit and close without applying unreviewed quantities", async () => {
    const count = await ready();
    const results = await Promise.all([call(close, count, { reviewToken: count.finalReview?.token }), call(patch, count, { items: [{ itemId: count.items.find((item) => item.ingredientId === a)!.id, countedQty: 4000 }] }, "PATCH")]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const persisted = await db.stockCount.findUniqueOrThrow({ where: { id: count.id } });
    if (persisted.status === "closed") { expect(await balance(a)).toBe(8000); expect(await adjustments(count)).toHaveLength(2); }
    else { expect(await balance(a)).toBe(10000); expect(await adjustments(count)).toHaveLength(0); expect(persisted.finalReview).toBeNull(); }
  });

  it("rejects another restaurant's reads, edits and workflow actions", async () => {
    const count = await ready();
    const foreign = await db.restaurant.create({ data: { name: "Otro comercio", slug: `foreign-${randomUUID()}` } }); tenants.push(foreign.id); scope.restaurantId = foreign.id;
    for (const [handler, method] of [[get, "GET"], [patch, "PATCH"], [preliminary, "POST"], [recount, "POST"], [review, "POST"], [close, "POST"], [remove, "DELETE"]] as const) {
      const response = await handler(request(method, method === "GET" ? undefined : { revision: count.revision, reviewToken: count.finalReview?.token, items: [{ itemId: count.items[0].id, countedQty: 1 }] }), { params: Promise.resolve({ id: count.id }) });
      expect(response.status).toBe(404);
    }
    expect(await balance(a)).toBe(10000); expect(await adjustments(count)).toHaveLength(0);
  });

  it.each([{ trackInventory: false }, { measureKind: "count" as const }])("blocks final review after changing inventory semantics: %o", async (change) => {
    const count = await ready();
    await db.ingredient.update({ where: { id: a }, data: change });
    const response = await call(review, count); expect(response.status).toBe(409);
    expect(await adjustments(count)).toHaveLength(0); expect(await balance(a)).toBe(10000);
  });
});
