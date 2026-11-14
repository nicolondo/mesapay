import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { applyStockMovement } from "../src/lib/erp/stock";
import { parseRecountPlan } from "../src/lib/erp/recountPlan";
import { POST as create } from "../src/app/api/operator/stock/counts/route";
import { PATCH as patch } from "../src/app/api/operator/stock/counts/[id]/route";
import { POST as preliminary } from "../src/app/api/operator/stock/counts/[id]/preliminary/route";
import { POST as recount } from "../src/app/api/operator/stock/counts/[id]/recount/route";
import { POST as review } from "../src/app/api/operator/stock/counts/[id]/review/route";
import { POST as close } from "../src/app/api/operator/stock/counts/[id]/close/route";

// El conteo definitivo solo pide recontar lo necesario — rutas reales, lock
// de stock y PostgreSQL real (movimientos con su fecha de la base).
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/erp/access", () => ({ getErpContext: async () => ({ restaurantId: scope.restaurantId, country: "CO" }), isDenied: () => false }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) throw new Error("Isolated local database required");

type Item = { id: string; ingredientId: string; expectedQty: number; countedQty: number | null; countedParts: number[]; preliminaryQty: number | null; finalExpectedQty: number | null };
type Count = { id: string; revision: number; status: string; createdAt: string; finalReview: { token: string } | null; recountSnapshot: unknown; items: Item[] };
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const tenants: string[] = [];
const ids: Record<string, string> = {};
const request = (method: string, data?: unknown) => new Request("http://localhost/api/operator/stock/counts", { method, headers: { "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const call = (handler: Handler, count: Count, data: Record<string, unknown> = {}, method = "POST") => handler(request(method, { revision: count.revision, ...data }), { params: Promise.resolve({ id: count.id }) });
async function ok(response: Response): Promise<Count> { const body = await response.json(); expect(response.status, JSON.stringify(body)).toBeLessThan(300); return body.count; }
const item = (count: Count, name: string) => count.items.find((entry) => entry.ingredientId === ids[name])!;
async function save(count: Count, quantities: Record<string, number | number[]>) {
  return ok(await call(patch, count, { items: Object.entries(quantities).map(([name, value]) => {
    const parts = Array.isArray(value) ? value : [value];
    return { itemId: item(count, name).id, countedQty: parts.reduce((sum, part) => sum + part, 0), countedParts: parts };
  }) }, "PATCH"));
}
const move = (name: string, kind: "sale_consumption" | "adjust_in" | "adjust_out", qtyBase: number) =>
  db.$transaction((tx) => applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId: ids[name], kind, qtyBase }));
const balance = async (name: string) => (await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: ids[name] } })).qtyBase;

beforeEach(async () => {
  const restaurant = await db.restaurant.create({ data: { name: "Definitivo", slug: `definitive-${randomUUID()}`, enabledModules: ["inventory"] } });
  tenants.push(restaurant.id); scope.restaurantId = restaurant.id;
  for (const [name, qty] of [["arroz", 10_000], ["azucar", 20_000], ["cafe", 3000], ["harina", 6000], ["leche", 8000], ["sal", 2000]] as const) {
    ids[name] = (await db.ingredient.create({ data: { restaurantId: restaurant.id, name, measureKind: "count", stockLevel: { create: { restaurantId: restaurant.id, qtyBase: qty, totalValueCents: qty * 3 } } } })).id;
  }
  // Un movimiento ANTERIOR a abrir el conteo no cuenta.
  await move("arroz", "adjust_in", 1000);
  await move("arroz", "adjust_out", 1000);
});
afterAll(async () => { await db.restaurant.deleteMany({ where: { id: { in: tenants } } }); await db.$disconnect(); });

/** Conteo inicial + preliminar: arroz/azúcar/leche/sal cuadran, café falta, harina sin contar. */
async function preliminaryReady() {
  let count = await ok(await create(request("POST", {})));
  count = await save(count, { arroz: 10_000, azucar: [12_000, 8000], cafe: 2000, leche: 8000, sal: 2000 });
  return ok(await call(preliminary, count));
}

describe("conteo definitivo: solo lo que hay que recontar", () => {
  it("arrastra lo que cuadró y no se movió; pide recontar diferencias, lo no contado y lo que se movió después de abrir el conteo", async () => {
    let count = await preliminaryReady();
    await move("leche", "sale_consumption", 1000);
    await move("sal", "adjust_in", 500);
    await move("sal", "adjust_out", 500);
    count = await ok(await call(recount, count));

    expect(item(count, "arroz")).toMatchObject({ countedQty: 10_000, countedParts: [10_000], finalExpectedQty: 10_000 });
    expect(item(count, "azucar")).toMatchObject({ countedQty: 20_000, countedParts: [12_000, 8000], finalExpectedQty: 20_000 });
    expect(item(count, "cafe")).toMatchObject({ countedQty: null, preliminaryQty: 2000, finalExpectedQty: 3000 });
    expect(item(count, "harina")).toMatchObject({ countedQty: null, preliminaryQty: null, finalExpectedQty: 6000 });
    expect(item(count, "leche")).toMatchObject({ countedQty: null, preliminaryQty: 8000, finalExpectedQty: 7000 });
    // Saldo igual, pero entró y salió mercancía: hay que recontarla.
    expect(item(count, "sal")).toMatchObject({ countedQty: null, preliminaryQty: 2000, finalExpectedQty: 2000 });
    expect(parseRecountPlan(count.recountSnapshot)).toEqual({
      full: false,
      reasons: { [ids.cafe]: ["difference"], [ids.harina]: ["uncounted"], [ids.leche]: ["moved"], [ids.sal]: ["moved"] },
    });

    // Falta recontar lo pendiente; lo arrastrado ya cuenta.
    count = await save(count, { cafe: 2000, harina: 6000, leche: 7000 });
    const incomplete = await call(review, count);
    expect(incomplete.status).toBe(400);
    expect(await incomplete.json()).toEqual({ error: "incomplete_count" });
    count = await save(count, { sal: 2000 });
    count = await ok(await call(review, count));

    const closed = await call(close, count, { reviewToken: count.finalReview?.token });
    const body = await closed.json();
    expect(closed.status).toBe(200);
    expect(body.adjustments).toBe(1);
    expect([await balance("arroz"), await balance("azucar"), await balance("cafe"), await balance("harina"), await balance("leche"), await balance("sal")])
      .toEqual([10_000, 20_000, 2000, 6000, 7000, 2000]);
    expect((await db.stockMovement.findMany({ where: { stockCountId: count.id } })).map((movement) => [movement.ingredientId, movement.qtyBase])).toEqual([[ids.cafe, -1000]]);
  });

  it("si un confirmado se mueve durante el definitivo, el cierre se niega y al reiniciar ya no se confirma", async () => {
    let count = await preliminaryReady();
    count = await ok(await call(recount, count));
    count = await save(count, { cafe: 2000, harina: 6000 });
    count = await ok(await call(review, count));
    await move("arroz", "sale_consumption", 500);
    const changed = await call(close, count, { reviewToken: count.finalReview?.token });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: "stock_changed" });
    expect(await db.stockMovement.count({ where: { stockCountId: count.id } })).toBe(0);
    count = await ok(await call(recount, count));
    expect(item(count, "arroz")).toMatchObject({ countedQty: null, finalExpectedQty: 9500 });
    expect(parseRecountPlan(count.recountSnapshot)?.reasons[ids.arroz]).toEqual(["moved"]);
    // Lo que sigue quieto continúa confirmado.
    expect(item(count, "azucar").countedQty).toBe(20_000);
  });

  it("«Recontar todo» vacía todo y el conteo exige contar todos los insumos", async () => {
    let count = await preliminaryReady();
    const bad = await call(recount, count, { full: "yes" });
    expect(bad.status).toBe(400);
    count = await ok(await call(recount, count, { full: true }));
    for (const entry of count.items) expect(entry.countedQty).toBeNull();
    expect(parseRecountPlan(count.recountSnapshot)?.full).toBe(true);
    count = await save(count, { cafe: 2000, harina: 6000, leche: 8000, sal: 2000 });
    const incomplete = await call(review, count);
    expect(incomplete.status).toBe(400);
    expect(await incomplete.json()).toEqual({ error: "incomplete_count" });
    // Y volver a iniciar sin `full` aplica la regla de nuevo.
    count = await ok(await call(recount, count));
    expect(item(count, "arroz").countedQty).toBe(10_000);
    expect(item(count, "cafe").countedQty).toBeNull();
  });
});
