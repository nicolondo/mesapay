import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { PATCH as changeBarcode, POST as addBarcode } from "../src/app/api/operator/ingredients/[id]/barcode/route";
import { POST as createIngredient } from "../src/app/api/operator/ingredients/route";
import { POST as createCount } from "../src/app/api/operator/stock/counts/route";
import { PATCH as saveCount } from "../src/app/api/operator/stock/counts/[id]/route";
import { POST as appendItem } from "../src/app/api/operator/stock/counts/[id]/items/route";
import { GET as scanLookup } from "../src/app/api/operator/stock/counts/[id]/scan/route";
import { POST as preliminary } from "../src/app/api/operator/stock/counts/[id]/preliminary/route";
import { POST as recount } from "../src/app/api/operator/stock/counts/[id]/recount/route";
import { POST as review } from "../src/app/api/operator/stock/counts/[id]/review/route";
import { POST as close } from "../src/app/api/operator/stock/counts/[id]/close/route";
import { applyStockMovement } from "../src/lib/erp/stock";

// Rutas reales + PostgreSQL real (triggers del registro de códigos incluidos):
// pasar/editar códigos, explicar un escaneo, sumar un insumo a un conteo y
// cerrar un conteo con un insumo nacido en él.
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { email: "count-compact@example.invalid", role: "operator" } }) }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

type Registry = { id: string; barcode: string | null; barcodes: { barcode: string }[] };
type Item = { id: string; ingredientId: string; expectedQty: number; countedQty: number | null; preliminaryQty: number | null; finalExpectedQty: number | null };
type Count = { id: string; revision: number; status: string; finalReview: { token: string } | null; items: Item[] };
type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const tenants: string[] = [];
const json = (method: string, body?: unknown, url = "http://localhost/api") => new Request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const at = (id: string) => ({ params: Promise.resolve({ id }) });
const ingredient = (name: string, overrides: { barcode?: string | null; active?: boolean; trackInventory?: boolean; category?: string | null; qty?: number; value?: number; measureKind?: "count" | "mass" } = {}) => db.ingredient.create({ data: {
  restaurantId: scope.restaurantId, name, measureKind: overrides.measureKind ?? "count", barcode: overrides.barcode ?? null, category: overrides.category ?? null,
  active: overrides.active ?? true, trackInventory: overrides.trackInventory ?? true,
  ...(overrides.qty === undefined ? {} : { stockLevel: { create: { restaurantId: scope.restaurantId, qtyBase: overrides.qty, totalValueCents: overrides.value ?? overrides.qty * 10 } } }),
} });
const registry = async (id: string): Promise<{ barcode: string | null; codes: string[] }> => {
  const row = await db.ingredient.findUniqueOrThrow({ where: { id }, select: { barcode: true, barcodes: { select: { barcode: true }, orderBy: { barcode: "asc" } } } });
  return { barcode: row.barcode, codes: row.barcodes.map((entry) => entry.barcode) };
};
const patchCode = (id: string, body: unknown) => changeBarcode(json("PATCH", body), at(id));
const audits = (kind: string) => db.auditEvent.findMany({ where: { restaurantId: scope.restaurantId, kind }, orderBy: { occurredAt: "asc" } });

async function ok<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body as T;
}
const start = async (category?: string) => (await ok<{ count: Count }>(await createCount(json("POST", category ? { category } : {})), 201)).count;
const call = async (handler: Handler, count: Count, data: Record<string, unknown> = {}, method = "POST") =>
  (await ok<{ count: Count; adjustments?: number }>(await handler(json(method, { revision: count.revision, ...data }), at(count.id))));
const save = async (count: Count, quantities: Record<string, number>) => (await call(saveCount, count, {
  items: count.items.filter((item) => item.ingredientId in quantities).map((item) => ({ itemId: item.id, countedQty: quantities[item.ingredientId] })),
}, "PATCH")).count;
const append = (count: Count, ingredientId: string, revision = count.revision) => appendItem(json("POST", { revision, ingredientId }), at(count.id));
const lookup = async (count: Count, code: string) => (await ok<{ match: { state: string; itemId: string | null; canAppend: boolean; scopeCategory: string | null; ingredient: { id: string; name: string; active: boolean } } | null }>(
  await scanLookup(json("GET", undefined, `http://localhost/api?code=${encodeURIComponent(code)}`), at(count.id)),
)).match;

beforeEach(async () => {
  const tenant = await db.restaurant.create({ data: { name: "Conteo compacto", slug: `count-compact-${randomUUID()}`, enabledModules: ["inventory"], inventoryExcludedCategories: ["Aseo"] } });
  scope.restaurantId = tenant.id;
  tenants.push(tenant.id);
});
afterAll(async () => {
  await db.auditEvent.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

describe("pasar y editar códigos de barras en PostgreSQL", () => {
  it("el caso real: el código lo tiene un insumo archivado; se le pasa al activo y el archivado conserva todo lo demás", async () => {
    const old = await ingredient("Vino blanco (viejo)", { barcode: "7804436720807", active: false, qty: 6000 });
    const current = await ingredient("Vino blanco", { qty: 3000 });
    // Sin el traspaso, agregarlo al activo choca… y la respuesta ya dice con quién.
    const taken = await addBarcode(json("POST", { barcode: "7804436720807" }), at(current.id));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "barcode_taken", owner: { id: old.id, name: "Vino blanco (viejo)", active: false } });

    const before = await db.ingredient.findUniqueOrThrow({ where: { id: old.id }, include: { stockLevel: true } });
    const body = await ok<{ ingredient: Registry; target: Registry }>(await patchCode(old.id, { barcode: " 7804436720807\r\n", moveTo: current.id }));
    expect(body).toEqual({
      ingredient: { id: old.id, barcode: null, barcodes: [] },
      target: { id: current.id, barcode: "7804436720807", barcodes: [{ barcode: "7804436720807" }] },
    });
    expect(await registry(old.id)).toEqual({ barcode: null, codes: [] });
    expect(await registry(current.id)).toEqual({ barcode: "7804436720807", codes: ["7804436720807"] });
    // Un solo dueño en el registro canónico (único por comercio).
    expect(await db.ingredientBarcode.count({ where: { restaurantId: scope.restaurantId, barcode: "7804436720807" } })).toBe(1);
    const after = await db.ingredient.findUniqueOrThrow({ where: { id: old.id }, include: { stockLevel: true } });
    expect({ ...after, barcode: before.barcode, updatedAt: before.updatedAt }).toEqual(before);
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
    const [event] = await audits("ingredient.barcode.move");
    expect(event).toMatchObject({ targetType: "ingredient", targetId: current.id, summary: "Vino blanco (viejo) → Vino blanco", actorEmail: "count-compact@example.invalid" });
    expect(event.diff).toEqual({
      before: { barcode: "7804436720807", ingredientId: old.id, ingredient: "Vino blanco (viejo)" },
      after: { barcode: "7804436720807", ingredientId: current.id, ingredient: "Vino blanco", sourcePrimary: null },
    });
  });

  it("al pasar el principal asciende el código MÁS ANTIGUO que queda; un adicional no toca el principal", async () => {
    const source = await ingredient("Aceite", { barcode: "P-1" });
    const target = await ingredient("Aceite de oliva", { barcode: "T-1" });
    await db.ingredientBarcode.create({ data: { restaurantId: scope.restaurantId, ingredientId: source.id, barcode: "A-NEW", createdAt: new Date("2026-03-01") } });
    await db.ingredientBarcode.create({ data: { restaurantId: scope.restaurantId, ingredientId: source.id, barcode: "Z-OLD", createdAt: new Date("2026-01-01") } });

    await ok(await patchCode(source.id, { barcode: "P-1", moveTo: target.id }));
    expect(await registry(source.id)).toEqual({ barcode: "Z-OLD", codes: ["A-NEW", "Z-OLD"] });
    expect(await registry(target.id)).toEqual({ barcode: "T-1", codes: ["P-1", "T-1"] });

    await ok(await patchCode(source.id, { barcode: "A-NEW", moveTo: target.id }));
    expect(await registry(source.id)).toEqual({ barcode: "Z-OLD", codes: ["Z-OLD"] });
    expect(await registry(target.id)).toEqual({ barcode: "T-1", codes: ["A-NEW", "P-1", "T-1"] });
    expect((await audits("ingredient.barcode.move")).map((event) => (event.diff as { after: Record<string, unknown> }).after.sourcePrimary)).toEqual(["Z-OLD", undefined]);
  });

  it("el destino debe estar activo, llevar inventario y ser del mismo comercio; si no, nada cambia", async () => {
    const source = await ingredient("Harina", { barcode: "H-1" });
    const archived = await ingredient("Harina vieja", { active: false });
    const untracked = await ingredient("Flete", { trackInventory: false });
    const other = await db.restaurant.create({ data: { name: "Otro", slug: `other-${randomUUID()}`, enabledModules: ["inventory"] } });
    tenants.push(other.id);
    const foreign = await db.ingredient.create({ data: { restaurantId: other.id, name: "Ajeno", measureKind: "count" } });
    for (const [targetId, status, error] of [[archived.id, 409, "ingredient_inactive"], [untracked.id, 409, "ingredient_not_tracked"], [foreign.id, 404, "target_not_found"], [source.id, 400, "invalid"]] as const) {
      const response = await patchCode(source.id, { barcode: "H-1", moveTo: targetId });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
    expect((await patchCode(foreign.id, { barcode: "H-1", moveTo: source.id })).status).toBe(404);
    expect(await registry(source.id)).toEqual({ barcode: "H-1", codes: ["H-1"] });
    expect(await audits("ingredient.barcode.move")).toHaveLength(0);
  });

  it("editar un código conserva su lugar y respeta la unicidad por comercio", async () => {
    const item = await ingredient("Leche", { barcode: "7701" });
    const neighbour = await ingredient("Crema", { barcode: "8800" });
    await ok(await addBarcode(json("POST", { barcode: "ALT-1" }), at(item.id)));
    // El principal mal digitado se corrige y sigue siendo el principal.
    expect((await ok<{ ingredient: Registry }>(await patchCode(item.id, { barcode: "7701", newBarcode: " 77 02\t" }))).ingredient).toEqual({ id: item.id, barcode: "7702", barcodes: [{ barcode: "7702" }, { barcode: "ALT-1" }] });
    // Un adicional cambia sin tocar el principal.
    await ok(await patchCode(item.id, { barcode: "ALT-1", newBarcode: "ALT-2" }));
    expect(await registry(item.id)).toEqual({ barcode: "7702", codes: ["7702", "ALT-2"] });
    // No pisa el de otro insumo: dice quién lo tiene, y nada cambia.
    const taken = await patchCode(item.id, { barcode: "ALT-2", newBarcode: "8800" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "barcode_taken", owner: { id: neighbour.id, name: "Crema", active: true } });
    expect(await registry(item.id)).toEqual({ barcode: "7702", codes: ["7702", "ALT-2"] });
    expect(await registry(neighbour.id)).toEqual({ barcode: "8800", codes: ["8800"] });
    // El valor viejo queda libre para otro insumo.
    await ok(await addBarcode(json("POST", { barcode: "7701" }), at(neighbour.id)));
    expect((await audits("ingredient.barcode.replace")).map((event) => event.diff)).toEqual([
      { before: { barcode: "7701" }, after: { barcode: "7702" } },
      { before: { barcode: "ALT-1" }, after: { barcode: "ALT-2" } },
    ]);
  });
});

describe("un código escaneado que el conteo no encuentra", () => {
  it("la API explica de quién es y por qué no está: archivado, sin inventario, categoría sin inventario, otra categoría o agregado después", async () => {
    const inCount = await ingredient("Ron", { category: "Licores", barcode: "RON-1", qty: 1000 });
    await ingredient("Gin", { category: "Licores", barcode: "GIN-1", qty: 1000 });
    const count = await start("Licores");
    const archived = await ingredient("Vino viejo", { category: "Licores", barcode: "ARCH-1", active: false, qty: 500 });
    await ingredient("Flete", { category: "Servicios", barcode: "SVC-1", trackInventory: false });
    await ingredient("Jabón", { category: "Aseo", barcode: "ASEO-1" });
    await ingredient("Arroz", { category: "Abarrotes", barcode: "RICE-1" });
    await ingredient("Vodka", { category: "Licores", barcode: "VODKA-1" });

    expect(await lookup(count, "NADIE-0")).toBeNull();
    expect(await lookup(count, " ron-1")).toBeNull(); // las mayúsculas distinguen códigos
    expect(await lookup(count, " RON-1\r\n")).toMatchObject({ state: "in_count", itemId: count.items.find((item) => item.ingredientId === inCount.id)!.id, canAppend: false });
    expect(await lookup(count, "ARCH-1")).toMatchObject({ state: "archived", itemId: null, canAppend: false, scopeCategory: "Licores", ingredient: { id: archived.id, name: "Vino viejo", active: false } });
    expect(await lookup(count, "SVC-1")).toMatchObject({ state: "not_tracked", canAppend: false });
    expect(await lookup(count, "ASEO-1")).toMatchObject({ state: "category_excluded", canAppend: false });
    expect(await lookup(count, "RICE-1")).toMatchObject({ state: "outside_scope", canAppend: true, scopeCategory: "Licores" });
    expect(await lookup(count, "VODKA-1")).toMatchObject({ state: "added_later", canAppend: true });
  });

  it("no cruza comercios: el código de otro comercio no existe para este conteo", async () => {
    await ingredient("Ron", { barcode: "RON-1", qty: 1000 });
    const count = await start();
    const home = scope.restaurantId;
    const other = await db.restaurant.create({ data: { name: "Otro", slug: `other-${randomUUID()}`, enabledModules: ["inventory"] } });
    tenants.push(other.id);
    await db.ingredient.create({ data: { restaurantId: other.id, name: "Ajeno", measureKind: "count", barcode: "FOREIGN-1" } });
    expect(await lookup(count, "FOREIGN-1")).toBeNull();
    scope.restaurantId = other.id;
    expect((await scanLookup(json("GET", undefined, "http://localhost/api?code=RON-1"), at(count.id))).status).toBe(404);
    scope.restaurantId = home;
  });
});

describe("sumar un insumo a un conteo y cerrarlo", () => {
  it("un insumo creado desde el conteo entra con existencia 0, se cuenta y al cerrar queda como sobrante sin costo", async () => {
    const rice = await ingredient("Arroz", { qty: 10_000, value: 100_000, measureKind: "mass" });
    let count = await start();
    count = await save(count, { [rice.id]: 9000 });

    const created = await ok<{ ingredient: { id: string } }>(await createIngredient(json("POST", { name: "Pimienta negra", measureKind: "count", barcode: " PIM 777\n" })), 201);
    const pepper = created.ingredient.id;
    expect(await db.stockLevel.findUnique({ where: { ingredientId: pepper } })).toBeNull();
    const appended = await ok<{ count: Count; itemId: string; added: boolean }>(await append(count, pepper));
    expect(appended.added).toBe(true);
    expect(appended.count.revision).toBe(count.revision + 1);
    expect(appended.count.items.find((item) => item.id === appended.itemId)).toMatchObject({ ingredientId: pepper, expectedQty: 0, countedQty: null, finalExpectedQty: null });
    // Lo ya guardado de los demás sigue igual; agregar dos veces no duplica.
    expect(appended.count.items.find((item) => item.ingredientId === rice.id)).toMatchObject({ countedQty: 9000 });
    const again = await ok<{ count: Count; itemId: string; added: boolean }>(await append(appended.count, pepper));
    expect(again).toMatchObject({ added: false, itemId: appended.itemId });
    expect(again.count.revision).toBe(appended.count.revision);
    // Una revisión vieja (otra ventana) se rechaza.
    const stale = await append(count, pepper);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "count_changed" });

    count = await save(again.count, { [pepper]: 4000 });
    count = (await call(preliminary, count)).count;
    expect(count.items.find((item) => item.ingredientId === pepper)).toMatchObject({ preliminaryQty: 4000, expectedQty: 0 });
    // Sobre el informe preliminar no se agregan insumos.
    const salt = await ingredient("Sal", { qty: 2000 });
    const blocked = await append(count, salt.id);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "recount_required" });

    count = (await call(recount, count)).count;
    expect(count.items.find((item) => item.ingredientId === pepper)).toMatchObject({ countedQty: null, finalExpectedQty: 0 });
    count = await save(count, { [rice.id]: 10_000, [pepper]: 5000 });
    count = (await call(review, count)).count;
    // Con la revisión final pendiente tampoco.
    const reviewing = await append(count, salt.id);
    expect(reviewing.status).toBe(409);
    expect(await reviewing.json()).toEqual({ error: "count_not_editable" });
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);

    const closed = await call(close, count, { reviewToken: count.finalReview?.token });
    expect(closed.count.status).toBe("closed");
    expect(closed.adjustments).toBe(1);
    // El saldo nace con el cierre: cantidad contada, valor 0 (no hay costo de dónde valorarlo).
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: pepper } })).toMatchObject({ qtyBase: 5000, totalValueCents: 0 });
    const movements = await db.stockMovement.findMany({ where: { restaurantId: scope.restaurantId } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ ingredientId: pepper, kind: "count_adjust", qtyBase: 5000, valueCents: 0, stockCountId: count.id });
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: rice.id } })).toMatchObject({ qtyBase: 10_000, totalValueCents: 100_000 });
    // Cerrado: ya no admite insumos.
    const afterClose = await append(closed.count, salt.id);
    expect(afterClose.status).toBe(409);
    expect(await afterClose.json()).toEqual({ error: "already_closed" });
  });

  it("agregado durante el conteo definitivo: no cuenta como «el inventario cambió», pero un movimiento real sí se detecta", async () => {
    const rice = await ingredient("Arroz", { qty: 10_000, measureKind: "mass" });
    let count = await save(await start(), { [rice.id]: 9000 });
    count = (await call(preliminary, count)).count;
    count = (await call(recount, count)).count;
    // Un insumo con existencias y movimientos previos, restaurado a mitad del definitivo.
    const late = await ingredient("Lenteja", { measureKind: "mass" });
    await db.$transaction((tx) => applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId: late.id, kind: "purchase_in", qtyBase: 750, totalCostCents: 3000 }));
    const appended = await ok<{ count: Count; itemId: string }>(await append(count, late.id));
    expect(appended.count.items.find((item) => item.id === appended.itemId)).toMatchObject({ expectedQty: 750, finalExpectedQty: 750, preliminaryQty: null });
    count = await save(appended.count, { [rice.id]: 10_000 });
    // Falta contar el agregado.
    const incomplete = await review(json("POST", { revision: count.revision }), at(count.id));
    expect(incomplete.status).toBe(400);
    expect(await incomplete.json()).toEqual({ error: "incomplete_count" });
    count = await save(count, { [late.id]: 700 });
    count = (await call(review, count)).count;

    // Una venta del arroz después: el cierre se niega y nada se ajusta.
    await db.$transaction((tx) => applyStockMovement(tx, { restaurantId: scope.restaurantId, ingredientId: rice.id, kind: "sale_consumption", qtyBase: 500 }));
    const changed = await close(json("POST", { revision: count.revision, reviewToken: count.finalReview?.token }), at(count.id));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: "stock_changed" });
    expect(await db.stockMovement.count({ where: { stockCountId: count.id } })).toBe(0);

    // Se reinicia el definitivo, se cuenta de nuevo y ahora sí cierra con sus ajustes.
    count = (await call(recount, count)).count;
    expect(count.items.find((item) => item.ingredientId === late.id)).toMatchObject({ countedQty: null, finalExpectedQty: 750 });
    count = await save(count, { [rice.id]: 9500, [late.id]: 700 });
    count = (await call(review, count)).count;
    const closed = await call(close, count, { reviewToken: count.finalReview?.token });
    expect(closed.adjustments).toBe(1);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: late.id } })).toMatchObject({ qtyBase: 700 });
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: rice.id } })).toMatchObject({ qtyBase: 9500 });
  });

  it("solo entran insumos activos, con inventario y del mismo comercio", async () => {
    await ingredient("Arroz", { qty: 1000 });
    const count = await start();
    const archived = await ingredient("Viejo", { active: false });
    const untracked = await ingredient("Flete", { trackInventory: false });
    const other = await db.restaurant.create({ data: { name: "Otro", slug: `other-${randomUUID()}`, enabledModules: ["inventory"] } });
    tenants.push(other.id);
    const foreign = await db.ingredient.create({ data: { restaurantId: other.id, name: "Ajeno", measureKind: "count" } });
    for (const [id, status, error] of [[archived.id, 409, "ingredient_inactive"], [untracked.id, 409, "ingredient_not_tracked"], [foreign.id, 404, "ingredient_not_found"]] as const) {
      const response = await append(count, id);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
    expect(await db.stockCountItem.count({ where: { countId: count.id } })).toBe(1);
    expect((await db.stockCount.findUniqueOrThrow({ where: { id: count.id } })).revision).toBe(count.revision);
  });
});
