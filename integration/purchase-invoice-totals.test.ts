import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as confirmInvoice } from "../src/app/api/operator/purchase-invoices/[id]/confirm/route";
import { POST as payOrder } from "../src/app/api/operator/purchase-orders/[id]/payments/route";
import { DELETE as deletePayment } from "../src/app/api/operator/purchase-orders/[id]/payments/[paymentId]/route";
import { GET as listOrders, POST as createOrder } from "../src/app/api/operator/purchase-orders/route";
import { receivePurchaseOrder } from "../src/lib/erp/purchasing";
import { loadPurchasesBook, computeTaxSummary } from "../src/lib/erp/accountingData";
import { loadPurchaseTaxDocs } from "../src/lib/erp/reports/taxesQueries";
import { loadPayablesDocs } from "../src/lib/erp/reports/carteraQueries";
import { loadExogenaInputs } from "../src/lib/erp/exogena/queries";
import { purchaseOrderTotals } from "../src/lib/erp/purchaseTax";

const scope = vi.hoisted(() => ({ restaurantId: "" }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
vi.mock("../src/lib/erp/ledger", () => ({ loadAccountMap: async () => new Map([["110505", "test-cash-account"]]) }));

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

let tenantIds: string[] = [];
let supplierId = "";
let ingredientId = "";
const now = new Date();
const range = { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), to: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)) };
const cutoff = `${now.getUTCFullYear()}-12-31`;

beforeEach(async () => {
  const r = await db.restaurant.create({ data: { name: "Explicit purchase tax validation", slug: `explicit-tax-${randomUUID()}`, enabledModules: ["purchasing", "inventory"], purchaseIvaDeductible: false } });
  tenantIds = [...tenantIds, r.id];
  scope.restaurantId = r.id;
  supplierId = (await db.supplier.create({ data: { restaurantId: r.id, name: "Supplier validation" } })).id;
  ingredientId = (await db.ingredient.create({ data: { restaurantId: r.id, name: "Bottles validation", measureKind: "count" } })).id;
});

afterAll(async () => {
  await db.stockMovement.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenantIds } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenantIds } } });
  await db.$disconnect();
});

function line(overrides: Record<string, unknown> = {}) {
  return { ingredientId, qtyBase: 2_000, expectedCostCents: 8_483_400, expectedTaxCents: 424_200, expectedIncCents: 4_977_400, taxPct: 5, ...overrides };
}

async function confirm(mode: "draft" | "receive" = "receive", overrides: Record<string, unknown> = {}) {
  const upload = await db.purchaseInvoiceUpload.create({ data: { restaurantId: scope.restaurantId, fileUrl: "/uploads/validation-only.pdf", status: "pending", extraction: {} } });
  const response = await confirmInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${upload.id}/confirm`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ supplierId, lines: [line()], mode, incCents: 4_977_400, supplierInvoiceNumber: `validation-${randomUUID()}`, ...overrides }),
  }), { params: Promise.resolve({ id: upload.id }) });
  return { response, uploadId: upload.id };
}

async function savedOrder(response: Response) {
  expect(response.status).toBe(201);
  const body = await response.json();
  return db.purchaseOrder.findUniqueOrThrow({ where: { id: body.order.id }, include: { items: true, movements: true } });
}

describe("supplier invoice explicit VAT and fixed consumption", () => {
  it("persists documentary tax on direct purchase orders and defaults header consumption to its lines", async () => {
    const response = await createOrder(new Request("http://localhost/api/operator/purchase-orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ supplierId, lines: [line()], notes: "Documentary validation" }) }));
    const order = await savedOrder(response);
    expect(order).toMatchObject({ status: "draft", incCents: 4_977_400 });
    expect(order.items[0]).toMatchObject({ expectedTaxCents: 424_200, expectedIncCents: 4_977_400 });
    const draftPage = await (await listOrders(new Request("http://localhost/api/operator/purchase-orders?status=draft"))).json();
    expect(draftPage.orders.map((o: { id: string }) => o.id)).toEqual([order.id]);
    expect(draftPage.orders[0].items[0]).toMatchObject({ expectedTaxCents: 424_200, expectedIncCents: 4_977_400 });
  });

  it.each([
    { expectedTaxCents: -1 },
    { expectedCostCents: 0, expectedTaxCents: 1 },
    { qtyBase: null },
  ])("rejects invalid direct purchase amounts before persisting: %j", async (invalid) => {
    const response = await createOrder(new Request("http://localhost/api/operator/purchase-orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ supplierId, lines: [line(invalid)] }) }));
    expect(response.status).toBe(400);
    expect(await db.purchaseOrder.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
  });

  it("paginates twenty actual balances without skipping the rest of the examined batch", async () => {
    const prefix = `open-invoice-${randomUUID()}`;
    const ids = Array.from({ length: 21 }, (_, i) => `${prefix}-${String(i).padStart(2, "0")}`);
    await db.purchaseOrder.createMany({ data: ids.map((id, i) => ({ id, restaurantId: scope.restaurantId, supplierId, number: i + 1, status: "partially_received" as const, paidCents: 0 })) });
    await db.purchaseOrderItem.createMany({ data: ids.map((purchaseOrderId) => ({ purchaseOrderId, ingredientId, qtyOrderedBase: 2, receivedQtyBase: 1, expectedCostCents: 200, receivedCostCents: 100, taxPct: 0 })) });
    const first = await (await listOrders(new Request("http://localhost/api/operator/purchase-orders?unpaid=1"))).json();
    expect(first.orders.map((order: { id: string }) => order.id)).toEqual(ids.slice(0, 20));
    expect(first.nextCursor).toBe(ids[19]);
    const second = await (await listOrders(new Request(`http://localhost/api/operator/purchase-orders?unpaid=1&cursor=${first.nextCursor}`))).json();
    expect(second.orders.map((order: { id: string }) => order.id)).toEqual([ids[20]]);
    expect(second.nextCursor).toBeUndefined();
  });
  it("requires allocating a footer-only consumption before a new invoice can create inventory", async () => {
    const unallocated = await confirm("receive", { lines: [line({ expectedIncCents: 0 })] });
    expect(unallocated.response.status).toBe(400);
    expect(await db.purchaseOrder.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
    expect((await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: unallocated.uploadId } })).status).toBe("pending");
    const allocated = await savedOrder((await confirm()).response);
    expect(allocated.movements[0].valueCents).toBe(13_885_000);
  });
  it("derives unpaid lists and payables from documentary balances without rewriting legacy paid markers", async () => {
    const createLegacy = async (number: number, incCents: number, retefuenteCents: number, paidCents: number, paidAt: Date | null) => db.purchaseOrder.create({ data: {
      restaurantId: scope.restaurantId, supplierId, number, status: "received", receivedAt: now, paidAt, paidCents, incCents, retefuenteCents,
      items: { create: { ingredientId, qtyOrderedBase: 1_000, receivedQtyBase: 1_000, expectedCostCents: 10_000_000, receivedCostCents: 10_000_000, taxPct: 5 } },
      payments: { create: { restaurantId: scope.restaurantId, amountCents: paidCents, paidAt: now, accountCode: "110505" } },
    } });
    const hiddenDebt = await createLegacy(1, 800_000, 0, 10_500_000, now);
    const actuallySettled = await createLegacy(2, 0, 1_000_000, 9_500_000, null);
    await createLegacy(3, 0, 0, 10_500_000, now);
    const response = await listOrders(new Request("http://localhost/api/operator/purchase-orders?unpaid=1"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.orders.map((order: { id: string }) => order.id)).toContain(hiddenDebt.id);
    expect(body.orders.map((order: { id: string }) => order.id)).not.toContain(actuallySettled.id);
    expect(await loadPayablesDocs(scope.restaurantId, cutoff)).toEqual([
      expect.objectContaining({ id: hiddenDebt.id, totalCents: 11_300_000, outstandingCents: 800_000 }),
    ]);
    expect((await loadPurchasesBook(scope.restaurantId, range)).totals.unpaidCents).toBe(800_000);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: hiddenDebt.id } })).paidAt).toEqual(now);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: actuallySettled.id } })).paidAt).toBeNull();
  });

  it("advances a bounded unpaid scan past paid candidates without skipping older debt", async () => {
    const prefix = `invoice-scan-${randomUUID()}`;
    const ids = Array.from({ length: 101 }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
    await db.purchaseOrder.createMany({ data: ids.map((id, i) => ({ id, restaurantId: scope.restaurantId, supplierId, number: i + 1, status: "received" as const, receivedAt: now, paidAt: now, paidCents: i < 100 ? 110 : 100, incCents: 10 })) });
    await db.purchaseOrderItem.createMany({ data: ids.map((purchaseOrderId) => ({ purchaseOrderId, ingredientId, qtyOrderedBase: 1, receivedQtyBase: 1, expectedCostCents: 100, receivedCostCents: 100, taxPct: 0 })) });
    const first = await (await listOrders(new Request("http://localhost/api/operator/purchase-orders?unpaid=1"))).json();
    expect(first.orders).toEqual([]);
    expect(first.nextCursor).toBe(ids[99]);
    const second = await (await listOrders(new Request(`http://localhost/api/operator/purchase-orders?unpaid=1&cursor=${first.nextCursor}`))).json();
    expect(second.orders.map((order: { id: string }) => order.id)).toEqual([ids[100]]);
    expect(second.nextCursor).toBeUndefined();
    const foreign = await db.restaurant.create({ data: { name: "Foreign purchase validation", slug: `foreign-${randomUUID()}`, enabledModules: ["purchasing"] } });
    tenantIds = [...tenantIds, foreign.id];
    scope.restaurantId = foreign.id;
    expect((await (await listOrders(new Request("http://localhost/api/operator/purchase-orders?unpaid=1"))).json()).orders).toEqual([]);
  });
  it.each([true, false])("preserves gross across confirmation, inventory and documentary reports; deductible=%s", async (deductible) => {
    await db.restaurant.update({ where: { id: scope.restaurantId }, data: { purchaseIvaDeductible: deductible } });
    const order = await savedOrder((await confirm()).response);
    expect(order.items[0]).toMatchObject({ expectedCostCents: 8_483_400, expectedTaxCents: 424_200, expectedIncCents: 4_977_400, receivedCostCents: 8_483_400, receivedQtyBase: 2_000 });
    expect(order.movements).toHaveLength(1);
    expect(order.movements[0].valueCents).toBe(deductible ? 13_460_800 : 13_885_000);
    expect((await db.stockLevel.findUniqueOrThrow({ where: { ingredientId } })).totalValueCents).toBe(deductible ? 13_460_800 : 13_885_000);
    expect(purchaseOrderTotals(order, "received").totalCents).toBe(13_885_000);
    expect((await loadPurchasesBook(scope.restaurantId, range)).totals).toMatchObject({ receivedCents: 8_483_400, ivaCents: 424_200, incCents: 4_977_400 });
    expect((await computeTaxSummary(scope.restaurantId, range)).purchases).toMatchObject({ ivaCents: 424_200, incCents: 4_977_400 });
    expect((await loadPurchaseTaxDocs(scope.restaurantId, range.from, range.to))[0]).toMatchObject({ lines: [{ netCents: 8_483_400, taxCents: 424_200 }], incCents: 4_977_400 });
    expect((await loadPayablesDocs(scope.restaurantId, cutoff))[0]).toMatchObject({ totalCents: 13_885_000, outstandingCents: 13_885_000 });
    const exogena = await loadExogenaInputs(scope.restaurantId, now.getUTCFullYear());
    expect(exogena.purchases[0].ivaCents).toBe(424_200);
    expect(exogena.payables[0].totalCents).toBe(13_885_000);
  });

  it("permits exact payment, rejects overpayment and restores the same balance when reversing it", async () => {
    const order = await savedOrder((await confirm()).response);
    const pay = async (amountCents: number) => payOrder(new Request(`http://localhost/api/operator/purchase-orders/${order.id}/payments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amountCents, accountCode: "110505" }) }), { params: Promise.resolve({ id: order.id }) });
    expect((await pay(13_885_001)).status).toBe(400);
    const response = await pay(13_885_000);
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({ totalCents: 13_885_000, outstandingCents: 0 });
    const reversed = await deletePayment(new Request(`http://localhost/api/operator/purchase-orders/${order.id}/payments/${result.payment.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: order.id, paymentId: result.payment.id }) });
    expect(reversed.status).toBe(200);
    expect(await reversed.json()).toMatchObject({ totalCents: 13_885_000, outstandingCents: 13_885_000 });
  });

  it("preserves each accumulated cent over three partial receipts", async () => {
    const order = await savedOrder((await confirm("draft", { lines: [line({ qtyBase: 3, expectedCostCents: 3, expectedTaxCents: 2, expectedIncCents: 2 })], incCents: 2 })).response);
    for (let index = 0; index < 3; index += 1) {
      await db.$transaction((tx) => receivePurchaseOrder(tx, { restaurantId: scope.restaurantId, purchaseOrderId: order.id, lines: [{ itemId: order.items[0].id, qtyBase: 1, costCents: 1 }] }));
    }
    const movements = await db.stockMovement.findMany({ where: { purchaseOrderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(movements.map((m) => m.valueCents)).toEqual([3, 1, 3]);
    expect((await db.stockLevel.findUniqueOrThrow({ where: { ingredientId } })).totalValueCents).toBe(7);
    expect((await loadPurchasesBook(scope.restaurantId, range)).totals).toMatchObject({ receivedCents: 3, ivaCents: 2, incCents: 2 });
  });

  it("reopens the balance only when newly received goods exceed payments of an earlier partial receipt", async () => {
    const order = await savedOrder((await confirm("draft", { lines: [line({ qtyBase: 2, expectedCostCents: 10_000, expectedTaxCents: null, expectedIncCents: 0, taxPct: 0 })], incCents: 0 })).response);
    const receive = () => db.$transaction((tx) => receivePurchaseOrder(tx, { restaurantId: scope.restaurantId, purchaseOrderId: order.id, lines: [{ itemId: order.items[0].id, qtyBase: 1, costCents: 5_000 }] }));
    await receive();
    const payment = await payOrder(new Request(`http://localhost/api/operator/purchase-orders/${order.id}/payments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amountCents: 5_000, accountCode: "110505" }) }), { params: Promise.resolve({ id: order.id }) });
    expect(payment.status).toBe(201);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).paidAt).not.toBeNull();
    await receive();
    expect(await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ paidAt: null, paidCents: 5_000, status: "received" });
    expect(await db.purchasePayment.count({ where: { purchaseOrderId: order.id } })).toBe(1);
    expect(await loadPayablesDocs(scope.restaurantId, cutoff)).toEqual([expect.objectContaining({ id: order.id, outstandingCents: 5_000 })]);
    expect((await (await listOrders(new Request("http://localhost/api/operator/purchase-orders?unpaid=1"))).json()).orders.map((o: { id: string }) => o.id)).toEqual([order.id]);
  });

  it("freezes the actual consumption for non-stock receipts without reallocating to other ingredients", async () => {
    const tracked = await db.ingredient.create({ data: { restaurantId: scope.restaurantId, name: "Tracked validation", measureKind: "count" } });
    await db.ingredient.update({ where: { id: ingredientId }, data: { trackInventory: false } });
    const order = await savedOrder((await confirm("receive", { lines: [line(), line({ ingredientId: tracked.id, expectedCostCents: 8_483_400, expectedTaxCents: 0, expectedIncCents: 0, taxPct: 0 })] })).response);
    const untracked = order.items.find((item) => item.ingredientId === ingredientId)!;
    expect(untracked).toMatchObject({ nonInventoryReceivedCostCents: 8_483_400, nonInventoryReceivedNonDeductibleTaxCents: 424_200, nonInventoryReceivedIncCents: 4_977_400 });
    await db.ingredient.update({ where: { id: ingredientId }, data: { trackInventory: true } });
    const book = await loadPurchasesBook(scope.restaurantId, range);
    expect(book.totals).toMatchObject({ nonInventoryIncCents: 4_977_400, nonInventoryNonDeductibleTaxCents: 424_200 });
    expect(order.movements).toHaveLength(1);
    expect(order.movements[0].ingredientId).toBe(tracked.id);
    expect(order.movements[0].valueCents).toBe(8_483_400);
  });

  it.each([
    { expectedTaxCents: -1 },
    { expectedTaxCents: 2_000_000_001 },
    { expectedTaxCents: 0.5 },
    { expectedIncCents: -1 },
    { expectedCostCents: 0, expectedTaxCents: 1 },
    { incCents: 4_977_399 },
  ])("rejects invalid documentary amounts with no purchase or stock writes: %j", async (invalid) => {
    const overrides = "incCents" in invalid ? invalid : { lines: [line(invalid)] };
    const { response, uploadId } = await confirm("receive", overrides);
    expect(response.status).toBe(400);
    expect(await db.purchaseOrder.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
    expect((await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: uploadId } })).status).toBe("pending");
  });
});
