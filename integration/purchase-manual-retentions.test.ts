import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { monthRange } from "../src/lib/erp/accounting";
import { generateJournalForMonth } from "../src/lib/erp/posting";
import { loadPurchasesBook } from "../src/lib/erp/accountingData";
import { purchaseOrderTotals } from "../src/lib/erp/purchaseTax";
import { purchaseRetentionTotals, suggestPurchaseRetentions } from "../src/lib/erp/purchaseRetentions";
import { POST as createOrder } from "../src/app/api/operator/purchase-orders/route";
import { POST as receiveOrder } from "../src/app/api/operator/purchase-orders/[id]/receive/route";
import { POST as payOrder } from "../src/app/api/operator/purchase-orders/[id]/payments/route";
import { GET as taxContext } from "../src/app/api/operator/purchase-orders/tax-context/route";

/**
 * Compras MANUALES con impuesto al consumo por línea y retenciones, contra
 * PostgreSQL real: «Nueva orden» con «Ya recibí esta mercancía» y una orden
 * recibida por partes. Lo que se guarda (líneas, cabecera, kardex), la cuenta
 * por pagar, los abonos y el asiento «Compras del día» (cuadra, regenerable).
 */
const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));

const database = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["localhost", "127.0.0.1"].includes(database.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(database.pathname)) {
  throw new Error("Isolated local database required");
}

const MONTH = "2026-10";
const RANGE = monthRange(MONTH)!;
/** 13:00 en Bogotá del 15-oct: la compra se asienta ese día de negocio. */
const RECEIVED_AT = new Date("2026-10-15T18:00:00Z");
const tenants: string[] = [];
let supplierId = "";
let beerId = "";
let oilId = "";

beforeEach(async () => {
  const r = await db.restaurant.create({
    data: {
      name: "Retenciones manuales",
      slug: `manual-ret-${randomUUID()}`,
      businessDayCutoffHour: 5,
      purchaseIvaDeductible: true,
      enabledModules: ["accounting", "purchasing", "inventory"],
    },
  });
  tenants.push(r.id);
  scope.restaurantId = r.id;
  supplierId = (await db.supplier.create({ data: { restaurantId: r.id, name: "Distribuidora", paymentTermsDays: 30 } })).id;
  beerId = (await db.ingredient.create({ data: { restaurantId: r.id, name: "Cerveza", measureKind: "count" } })).id;
  oilId = (await db.ingredient.create({ data: { restaurantId: r.id, name: "Aceite", measureKind: "volume" } })).id;
});

afterAll(async () => {
  if (tenants.length) {
    await db.journalEntry.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.stockMovement.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenants } } });
    await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  }
  await db.$disconnect();
});

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const create = (body: Record<string, unknown>) =>
  createOrder(new Request("http://localhost/api/operator/purchase-orders", json({ supplierId, ...body })));
const receive = (id: string, body: Record<string, unknown>) =>
  receiveOrder(new Request(`http://localhost/api/operator/purchase-orders/${id}/receive`, json(body)), { params: Promise.resolve({ id }) });
const pay = (id: string, amountCents: number) =>
  payOrder(new Request(`http://localhost/api/operator/purchase-orders/${id}/payments`, json({ amountCents, accountCode: "111005" })), {
    params: Promise.resolve({ id }),
  });

async function load(id: string) {
  return db.purchaseOrder.findUniqueOrThrow({
    where: { id },
    include: { items: { orderBy: { expectedCostCents: "desc" } }, movements: { orderBy: { createdAt: "asc" } } },
  });
}

/** Asiento «Compras del día» del mes: líneas netas por cuenta (débito − crédito). */
async function purchaseEntry(restaurantId: string) {
  await generateJournalForMonth(restaurantId, MONTH, RANGE);
  const entries = await db.journalEntry.findMany({
    where: { restaurantId, source: "purchase" },
    include: { lines: true },
  });
  expect(entries).toHaveLength(1);
  const lines = entries[0]!.lines.map((l) => ({ code: l.accountCode, debit: Number(l.debitCents), credit: Number(l.creditCents) }));
  expect(lines.reduce((s, l) => s + l.debit - l.credit, 0)).toBe(0);
  const byAccount = new Map<string, number>();
  for (const l of lines) byAccount.set(l.code, (byAccount.get(l.code) ?? 0) + l.debit - l.credit);
  return byAccount;
}

async function activateConcepts(restaurantId: string) {
  // Siembra el set estándar (inactivo) y activa compras + reteIVA + reteICA.
  await taxContext(new Request("http://localhost/api/operator/purchase-orders/tax-context"));
  await db.retentionConcept.updateMany({
    where: { restaurantId, OR: [{ name: { startsWith: "Compras" } }, { kind: { in: ["reteiva", "reteica"] } }] },
    data: { active: true },
  });
}

describe("«Ya recibí esta mercancía»: compra manual recibida con consumo, IVA y retenciones", () => {
  it("guarda el consumo como costo, practica las retenciones y el asiento cuadra", async () => {
    await activateConcepts(scope.restaurantId);
    const ctx = await (await taxContext(new Request("http://localhost/api/operator/purchase-orders/tax-context"))).json();
    expect(ctx.concepts.map((c: { kind: string }) => c.kind).sort()).toEqual(["retefuente", "reteica", "reteiva"]);
    expect(ctx.uvtCents).toBe(5_237_400);
    // Lo que la pantalla sugiere con los conceptos sembrados (la base es la
    // neta: el consumo no la sube) es lo que se manda abajo.
    const suggested = purchaseRetentionTotals(
      suggestPurchaseRetentions(ctx.concepts, { baseCents: 160_000_000, ivaCents: 11_400_000 }, ctx.uvtCents),
    );
    expect(suggested).toEqual({ retefuenteCents: 4_000_000, reteIvaCents: 1_710_000, reteIcaCents: 1_120_000 });

    // Cerveza $1.000.000 + consumo 8 % ($80.000); aceite $600.000 + IVA 19 %.
    // Base $1.600.000 (≥ 27 UVT): retefuente 2,5 % $40.000, reteIVA 15 % de
    // $114.000 = $17.100, reteICA 7×1.000 = $11.200.
    const res = await create({
      lines: [
        { ingredientId: beerId, qtyBase: 24, expectedCostCents: 100_000_000, taxPct: 0, expectedIncCents: 8_000_000 },
        { ingredientId: oilId, qtyBase: 20_000, expectedCostCents: 60_000_000, taxPct: 19 },
      ],
      receive: {
        supplierInvoiceNumber: "FE-901",
        retefuenteCents: 4_000_000,
        reteIvaCents: 1_710_000,
        reteIcaCents: 1_120_000,
      },
    });
    expect(res.status).toBe(201);
    const { order } = await res.json();
    const po = await load(order.id);
    expect(po).toMatchObject({
      status: "received",
      supplierInvoiceNumber: "FE-901",
      incCents: 8_000_000,
      retefuenteCents: 4_000_000,
      reteIvaCents: 1_710_000,
      reteIcaCents: 1_120_000,
      receptionRetentionCents: 6_830_000,
    });
    expect(po.invoiceDueAt).not.toBeNull(); // recepción + 30 días del proveedor
    expect(po.items[0]).toMatchObject({ taxPct: 0, expectedIncCents: 8_000_000, receivedCostCents: 100_000_000, receivedQtyBase: 24 });
    // Kardex: el consumo entra al costo; el IVA (descontable) no.
    expect(po.movements.map((m) => m.valueCents).sort((a, b) => b - a)).toEqual([108_000_000, 60_000_000]);

    // Cuenta por pagar = base + IVA + consumo − retenciones.
    expect(purchaseOrderTotals(po, "received")).toMatchObject({
      subtotalCents: 160_000_000,
      taxCents: 11_400_000,
      incCents: 8_000_000,
      retentionsCents: 6_830_000,
      totalCents: 172_570_000,
    });
    const over = await pay(po.id, 172_570_001);
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: "exceeds_balance" });
    expect((await pay(po.id, 172_570_000)).status).toBe(201);

    await db.purchaseOrder.update({ where: { id: po.id }, data: { receivedAt: RECEIVED_AT } });
    const book = await loadPurchasesBook(scope.restaurantId, RANGE);
    expect(book.totals).toMatchObject({ receivedCents: 160_000_000, incCents: 8_000_000, ivaCents: 11_400_000, retefuenteCents: 4_000_000, reteIvaCents: 1_710_000, reteIcaCents: 1_120_000 });

    const byAccount = await purchaseEntry(scope.restaurantId);
    expect(Object.fromEntries(byAccount)).toEqual({
      "143505": 168_000_000, // inventario: neto + consumo
      "24081001": 11_400_000, // IVA descontable
      "236505": -4_000_000,
      "236705": -1_710_000,
      "236805": -1_120_000,
      "220505": -172_570_000, // proveedores: lo que se le paga
    });
    // Regenerar no cambia nada.
    const again = await purchaseEntry(scope.restaurantId);
    expect(again).toEqual(byAccount);
  });

  it("una retención mayor que su base no deja nada guardado", async () => {
    const before = await db.purchaseOrder.count({ where: { restaurantId: scope.restaurantId } });
    const res = await create({
      lines: [{ ingredientId: oilId, qtyBase: 1_000, expectedCostCents: 1_000_000, taxPct: 19 }],
      receive: { reteIvaCents: 190_001 },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "retention_exceeds_base" });
    expect(await db.purchaseOrder.count({ where: { restaurantId: scope.restaurantId } })).toBe(before);
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
  });
});

describe("orden recibida por partes: impuesto de la factura y retenciones por entrega", () => {
  it("la primera entrega cambia IVA por consumo; cada entrega practica las suyas", async () => {
    // La orden se pidió con IVA 19 %; la factura trae impuesto al consumo.
    const created = await create({ lines: [{ ingredientId: beerId, qtyBase: 24, expectedCostCents: 24_000_000, taxPct: 19 }] });
    expect(created.status).toBe(201);
    const { order } = await created.json();
    const [item] = (await load(order.id)).items;

    // 1.ª entrega: 10 de 24, consumo 8 % = $8.000, reteICA $700.
    const first = await receive(order.id, {
      lines: [{ itemId: item!.id, qtyBase: 10, costCents: 10_000_000, taxPct: 0, incCents: 800_000 }],
      reteIcaCents: 70_000,
    });
    expect(first.status).toBe(200);
    let po = await load(order.id);
    expect(po).toMatchObject({ status: "partially_received", incCents: 1_920_000, reteIcaCents: 70_000, receptionRetentionCents: 70_000 });
    expect(po.items[0]).toMatchObject({ taxPct: 0, expectedTaxCents: null, expectedIncCents: 1_920_000 });
    expect(po.movements.map((m) => m.valueCents)).toEqual([10_800_000]);
    // Lo practicado en la entrega cuenta entero en la cuenta por pagar.
    expect(purchaseOrderTotals(po, "received")).toMatchObject({ taxCents: 0, incCents: 800_000, retentionsCents: 70_000, totalCents: 10_730_000 });

    // Con una entrega previa el impuesto ya no cambia: nada se guarda.
    const locked = await receive(order.id, {
      lines: [{ itemId: item!.id, qtyBase: 14, costCents: 14_000_000, taxPct: 19, incCents: 0 }],
    });
    expect(locked.status).toBe(400);
    expect(await locked.json()).toEqual({ error: "line_tax_locked" });
    po = await load(order.id);
    expect(po.movements).toHaveLength(1);
    expect(po.items[0]).toMatchObject({ receivedQtyBase: 10, expectedIncCents: 1_920_000 });

    // Retención mayor que la base de ESTA entrega: rechazada.
    const tooMuch = await receive(order.id, {
      lines: [{ itemId: item!.id, qtyBase: 14, costCents: 14_000_000 }],
      retefuenteCents: 14_000_001,
    });
    expect(tooMuch.status).toBe(400);
    expect(await tooMuch.json()).toEqual({ error: "retention_exceeds_base" });

    // 2.ª entrega: el resto, con su reteICA.
    const second = await receive(order.id, {
      lines: [{ itemId: item!.id, qtyBase: 14, costCents: 14_000_000 }],
      reteIcaCents: 98_000,
    });
    expect(second.status).toBe(200);
    po = await load(order.id);
    expect(po).toMatchObject({ status: "received", incCents: 1_920_000, reteIcaCents: 168_000, receptionRetentionCents: 168_000 });
    expect(po.movements.map((m) => m.valueCents)).toEqual([10_800_000, 15_120_000]);
    expect(purchaseOrderTotals(po, "received")).toMatchObject({
      subtotalCents: 24_000_000,
      taxCents: 0,
      incCents: 1_920_000,
      retentionsCents: 168_000,
      totalCents: 25_752_000,
    });

    await db.purchaseOrder.update({ where: { id: po.id }, data: { receivedAt: RECEIVED_AT } });
    const byAccount = await purchaseEntry(scope.restaurantId);
    expect(Object.fromEntries(byAccount)).toEqual({
      "143505": 25_920_000,
      "236805": -168_000,
      "220505": -25_752_000,
    });
  });

  it("IVA no descontable + consumo: los dos son costo y el kardex los lleva", async () => {
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { purchaseIvaDeductible: false } });
    const created = await create({
      lines: [{ ingredientId: beerId, qtyBase: 10, expectedCostCents: 1_000_000, taxPct: 19, expectedIncCents: 50_000 }],
    });
    const { order } = await created.json();
    const [item] = (await load(order.id)).items;
    const res = await receive(order.id, { lines: [{ itemId: item!.id, qtyBase: 10, costCents: 1_000_000 }] });
    expect(res.status).toBe(200);
    const po = await load(order.id);
    expect(po.movements.map((m) => m.valueCents)).toEqual([1_000_000 + 190_000 + 50_000]);
    await db.purchaseOrder.update({ where: { id: po.id }, data: { receivedAt: RECEIVED_AT } });
    const byAccount = await purchaseEntry(scope.restaurantId);
    expect(Object.fromEntries(byAccount)).toEqual({ "143505": 1_240_000, "220505": -1_240_000 });
  });
});
