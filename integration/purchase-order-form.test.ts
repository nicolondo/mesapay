import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { purchaseOrderTotals } from "../src/lib/erp/purchaseTax";
import { POST as createOrder } from "../src/app/api/operator/purchase-orders/route";
import { GET as recentItems } from "../src/app/api/operator/suppliers/[id]/recent-items/route";
import {
  blankLine,
  buildCreateOrderPayload,
  draftTotals,
  pickIngredient,
  resolveLines,
  type OcCatalog,
  type OcLine,
} from "../src/app/operator/compras/oc/draft";

/**
 * «Nueva orden» rápida contra PostgreSQL real: lo que la pantalla muestra
 * (draftTotals) es lo que el servidor guarda con el cuerpo que arma
 * (buildCreateOrderPayload) — descuentos por línea y del pie incluidos — y
 * lo que se recuerda del proveedor sale de sus órdenes no anuladas.
 */
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const tenants: string[] = [];
let supplierId = "";
let catalog: OcCatalog;

beforeEach(async () => {
  const r = await db.restaurant.create({
    data: { name: "Compras rápidas", slug: `po-form-${randomUUID()}`, country: "CO", enabledModules: ["purchasing", "inventory"] },
  });
  tenants.push(r.id);
  scope.restaurantId = r.id;
  supplierId = (await db.supplier.create({ data: { restaurantId: r.id, name: "Abarrotes" } })).id;
  const flour = await db.ingredient.create({ data: { restaurantId: r.id, name: "Harina", measureKind: "mass" } });
  const oil = await db.ingredient.create({ data: { restaurantId: r.id, name: "Aceite", measureKind: "volume", referencePriceCents: 900_000 } });
  const sack = await db.supplierIngredient.create({
    data: { supplierId, ingredientId: flour.id, presentationLabel: "Bulto 50 kg", contentQty: 50_000, lastPriceCents: 18_000_000 },
  });
  catalog = {
    priceList: [{ id: sack.id, presentationLabel: sack.presentationLabel, contentQty: sack.contentQty, lastPriceCents: sack.lastPriceCents, ingredient: { id: flour.id, name: flour.name, measureKind: "mass" } }],
    ingredients: [
      { id: flour.id, name: flour.name, measureKind: "mass", referencePriceCents: null },
      { id: oil.id, name: oil.name, measureKind: "volume", referencePriceCents: 900_000 },
    ],
    history: [],
  };
});

afterAll(async () => {
  if (tenants.length) {
    await db.stockMovement.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  }
  await db.$disconnect();
});

const post = (body: unknown) =>
  createOrder(new Request("http://localhost/api/operator/purchase-orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

/** Filas como las deja la pantalla: 3 bultos con 12,5 % y 4 L con IVA + consumo. */
function screenLines(): OcLine[] {
  const [flour, oil] = catalog.ingredients as [OcCatalog["ingredients"][number], OcCatalog["ingredients"][number]];
  return [
    { ...pickIngredient(blankLine(1), flour, catalog), qtyRaw: "3", discRaw: "12,5", discIsPct: true, tax: { ivaPct: 5, inc: false } },
    { ...pickIngredient(blankLine(2), oil, catalog), qtyRaw: "4", tax: { ivaPct: 19, inc: true }, incRaw: "8", incIsPct: true },
    blankLine(3),
  ];
}

const form = {
  orderDiscRaw: "10000",
  orderDiscIsPct: false,
  notes: " Llamar al llegar ",
  expectedAt: "2026-11-10",
  invoiceNumber: "FE-77",
  invoiceDueAt: "",
  retentions: { retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0 },
};

describe("«Nueva orden» rápida", () => {
  it("guarda exactamente lo que muestra: descuentos, IVA, consumo y presentaciones", async () => {
    const lines = resolveLines(screenLines()).lines;
    const shown = draftTotals(lines, form.orderDiscRaw, form.orderDiscIsPct);
    const res = await post(buildCreateOrderPayload({ ...form, supplierId, receivedNow: false, lines }));
    expect(res.status).toBe(201);
    const { order } = await res.json();
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(saved).toMatchObject({ status: "draft", notes: "Llamar al llegar", discountCents: shown.discountCents, incCents: shown.incCents });
    const flourItem = saved.items.find((i) => i.supplierItemId)!;
    expect(flourItem).toMatchObject({ presentations: 3, qtyOrderedBase: 150_000, listCostCents: 54_000_000, discountCents: 6_750_000 });
    expect(saved.items.map((i) => i.expectedCostCents).sort()).toEqual(shown.applied.lines.map((a) => a.netCents).sort());
    expect(purchaseOrderTotals(saved).totalCents).toBe(shown.totalCents);
  });

  it("«Ya recibí esta mercancía»: queda recibida con su factura", async () => {
    const lines = resolveLines(screenLines()).lines;
    const res = await post(buildCreateOrderPayload({ ...form, supplierId, receivedNow: true, lines }));
    expect(res.status).toBe(201);
    const { order } = await res.json();
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(saved).toMatchObject({ status: "received", supplierInvoiceNumber: "FE-77", expectedAt: null });
  });

  it("recuerda lo que se le pide al proveedor (sin las órdenes anuladas)", async () => {
    const lines = resolveLines(screenLines()).lines;
    const first = await (await post(buildCreateOrderPayload({ ...form, supplierId, receivedNow: false, lines }))).json();
    await post(buildCreateOrderPayload({ ...form, supplierId, receivedNow: false, lines: lines.slice(0, 1) }));
    const canceled = await (await post(buildCreateOrderPayload({ ...form, supplierId, receivedNow: false, lines: lines.slice(1) }))).json();
    await db.purchaseOrder.update({ where: { id: canceled.order.id }, data: { status: "canceled" } });
    expect(first.order.id).toBeTruthy();

    const res = await recentItems(new Request(`http://localhost/api/operator/suppliers/${supplierId}/recent-items`), { params: Promise.resolve({ id: supplierId }) });
    const history = await res.json();
    expect(history.orderCount).toBe(2);
    const flour = history.items.find((i: { ingredientId: string }) => i.ingredientId === catalog.ingredients[0]!.id);
    const oil = history.items.find((i: { ingredientId: string }) => i.ingredientId === catalog.ingredients[1]!.id);
    expect(flour).toMatchObject({ orders: 2, presentations: 3, listCostCents: 54_000_000, taxPct: 5 });
    expect(oil).toMatchObject({ orders: 1, qtyBase: 4000, taxPct: 19, incPct: 8 });

    // Con esa historia, elegir el aceite en otra orden recuerda L, 4, $9.000/L e IVA + consumo.
    const again = pickIngredient(blankLine(1), catalog.ingredients[1]!, { priceList: catalog.priceList, history: history.items });
    expect(again).toMatchObject({ unit: "L", qtyRaw: "4", priceRaw: "9000", priceSource: "history", tax: { ivaPct: 19, inc: true }, incRaw: "8" });
  });

  it("otro comercio no ve la historia del proveedor", async () => {
    const other = scope.restaurantId;
    scope.restaurantId = (await db.restaurant.create({ data: { name: "Otro", slug: `po-other-${randomUUID()}`, enabledModules: ["purchasing"] } })).id;
    tenants.push(scope.restaurantId);
    const res = await recentItems(new Request(`http://localhost/api/operator/suppliers/${supplierId}/recent-items`), { params: Promise.resolve({ id: supplierId }) });
    expect(res.status).toBe(404);
    scope.restaurantId = other;
  });
});
