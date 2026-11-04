import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PurchaseInvoiceExtraction, PurchaseInvoiceLineType } from "../src/lib/anthropic";
import { db } from "../src/lib/db";
import { POST as uploadInvoice } from "../src/app/api/operator/purchase-invoices/route";
import { GET as readInvoice } from "../src/app/api/operator/purchase-invoices/[id]/route";
import { POST as confirmInvoice } from "../src/app/api/operator/purchase-invoices/[id]/confirm/route";
import { POST as createOrder } from "../src/app/api/operator/purchase-orders/route";
import { POST as receiveOrder } from "../src/app/api/operator/purchase-orders/[id]/receive/route";
import { loadPurchasesBook } from "../src/lib/erp/accountingData";
import { purchaseOrderTotals } from "../src/lib/erp/purchaseTax";
import { inferPurchaseInvoiceTaxBases } from "../src/lib/erp/invoiceTaxBasis";

const scope = vi.hoisted(() => ({ restaurantId: "", extraction: null as PurchaseInvoiceExtraction | null, extract: vi.fn() }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
// Only the paid document-reading step is replaced by a synthetic extraction.
vi.mock("../src/lib/anthropic", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/anthropic")>(), extractPurchaseInvoice: scope.extract,
}));

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}
const tenants: string[] = [];
let supplierId = "", ingredientId = "", uploadDir = "";
const previousUploadDir = process.env.UPLOAD_DIR;
const now = new Date();
const range = { from: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), to: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)) };

function extractedLine(overrides: Partial<PurchaseInvoiceLineType> = {}): PurchaseInvoiceLineType {
  return {
    description: "Aceite de prueba", quantity: 2, unit: "un", unitPriceCents: 900_000,
    lineTotalCents: 1_800_000, unitPriceTaxBasis: "net", lineTotalTaxBasis: "net", unitPriceLabel: "P. UNIT ANTES IMPTO",
    listUnitPriceCents: 1_000_000, lineDiscountPct: 10, lineDiscountCents: null,
    taxPct: "19", lineTaxCents: 342_000, lineIncCents: 0, confidence: 1, ...overrides,
  };
}
function extraction(lines = [extractedLine()], totals: Partial<PurchaseInvoiceExtraction> = {}): PurchaseInvoiceExtraction {
  return {
    documentType: "factura", supplierName: "Proveedor descuentos", supplierNit: null,
    supplierInvoiceNumber: `DESC-${randomUUID()}`, issueDate: "2026-11-04", currency: "COP", lines,
    invoiceSubtotalCents: 2_000_000, invoiceDiscountCents: 200_000, invoiceTaxCents: 342_000, invoiceTotalCents: 2_142_000,
    invoiceIncCents: 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0, confidence: 1, ...totals,
  };
}

beforeAll(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), "mesapay-discount-upload-"));
  process.env.UPLOAD_DIR = uploadDir;
});
beforeEach(async () => {
  const r = await db.restaurant.create({ data: { name: "Descuentos de prueba", slug: `discounts-${randomUUID()}`, enabledModules: ["purchasing", "inventory"], purchaseIvaDeductible: true } });
  tenants.push(r.id);
  scope.restaurantId = r.id;
  supplierId = (await db.supplier.create({ data: { restaurantId: r.id, name: "Proveedor descuentos" } })).id;
  ingredientId = (await db.ingredient.create({ data: { restaurantId: r.id, name: "Aceite de prueba", measureKind: "count" } })).id;
  scope.extract.mockReset().mockImplementation(async () => inferPurchaseInvoiceTaxBases(scope.extraction!));
});
afterAll(async () => {
  await db.stockMovement.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.supplierPriceHistory.deleteMany({ where: { supplierItem: { supplier: { restaurantId: { in: tenants } } } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
  if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = previousUploadDir;
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

async function upload(raw: PurchaseInvoiceExtraction) {
  scope.extraction = raw;
  const form = new FormData();
  form.set("file", new File(["%PDF synthetic discount test only"], "invoice.pdf", { type: "application/pdf" }));
  const response = await uploadInvoice(new Request("http://localhost/api/operator/purchase-invoices", { method: "POST", body: form }));
  expect(response.status).toBe(200);
  return response.json() as Promise<{ uploadId: string; extraction: PurchaseInvoiceExtraction; match: { lines: { line: PurchaseInvoiceLineType }[] } }>;
}
function confirm(id: string, body: Record<string, unknown>) {
  return confirmInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${id}/confirm`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ supplierId, mode: "receive", supplierInvoiceNumber: "DESC-1", ...body }),
  }), { params: Promise.resolve({ id }) });
}
const reviewed = (fields: Record<string, unknown> = {}) => ({
  ingredientId, qtyBase: 2, expectedCostCents: 1_800_000, expectedTaxCents: 342_000, expectedIncCents: 0, taxPct: 19,
  listCostCents: 2_000_000, discountPct: 10, discountCents: null, ...fields,
});

describe("supplier discounts on imported invoices", () => {
  it("persists the printed discount fields, reopens them, and stores list + discount with the same net, AP and inventory", async () => {
    const result = await upload(extraction());
    expect(result.extraction.lines[0]).toMatchObject({ listUnitPriceCents: 1_000_000, lineDiscountPct: 10 });
    const reopened = await (await readInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${result.uploadId}`), { params: Promise.resolve({ id: result.uploadId }) })).json();
    expect(reopened.match.lines[0].line).toMatchObject({ listUnitPriceCents: 1_000_000, lineDiscountPct: 10 });

    const response = await confirm(result.uploadId, { lines: [reviewed()] });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, movements: true } });
    expect(saved).toMatchObject({ status: "received", discountCents: 200_000, discountPct: null });
    expect(saved.items[0]).toMatchObject({
      listCostCents: 2_000_000, discountPct: 10, discountCents: 200_000, orderDiscountCents: 0,
      expectedCostCents: 1_800_000, receivedCostCents: 1_800_000, expectedTaxCents: 342_000,
    });
    // Deductible VAT: inventory at the discounted net; AP at net + VAT.
    expect(saved.movements).toEqual([expect.objectContaining({ qtyBase: 2, valueCents: 1_800_000 })]);
    expect(purchaseOrderTotals(saved, "received")).toMatchObject({ subtotalCents: 1_800_000, taxCents: 342_000, totalCents: 2_142_000 });
    const book = await loadPurchasesBook(scope.restaurantId, range);
    expect(book.totals).toMatchObject({ receivedCents: 1_800_000, ivaCents: 342_000 });
  });

  it("prorates a document discount exactly as purchase orders do and keeps the reviewed VAT", async () => {
    const result = await upload(extraction([
      extractedLine({ listUnitPriceCents: null, lineDiscountPct: null, lineTotalCents: 6_000_000, quantity: 1 }),
      extractedLine({ description: "Harina de prueba", listUnitPriceCents: null, lineDiscountPct: null, lineTotalCents: 4_000_000, quantity: 1, taxPct: "5" }),
    ], { invoiceSubtotalCents: 10_000_000, invoiceDiscountCents: 1_000_000, invoiceTaxCents: 1_206_000, invoiceTotalCents: 10_206_000 }));
    const second = (await db.ingredient.create({ data: { restaurantId: scope.restaurantId, name: "Harina de prueba", measureKind: "count" } })).id;
    const response = await confirm(result.uploadId, { mode: "draft", discountCents: 1_000_000, lines: [
      reviewed({ qtyBase: 1, listCostCents: 6_000_000, discountPct: null, expectedCostCents: 5_400_000, expectedTaxCents: 1_026_000 }),
      reviewed({ ingredientId: second, qtyBase: 1, taxPct: 5, listCostCents: 4_000_000, discountPct: null, expectedCostCents: 3_600_000, expectedTaxCents: 180_000 }),
    ] });
    expect(response.status).toBe(201);
    const { order } = await response.json();
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: { orderBy: { expectedCostCents: "desc" } } } });
    expect(saved).toMatchObject({ status: "draft", discountCents: 1_000_000 });
    expect(saved.items.map(i => [i.listCostCents, i.orderDiscountCents, i.expectedCostCents, i.expectedTaxCents])).toEqual([
      [6_000_000, 600_000, 5_400_000, 1_026_000], [4_000_000, 400_000, 3_600_000, 180_000],
    ]);
    expect(purchaseOrderTotals(saved).totalCents).toBe(10_206_000);
  });

  it.each([
    ["the discount again on a net price", reviewed({ listCostCents: 1_800_000 })],
    ["a list price that does not reach the reviewed net", reviewed({ discountPct: 5 })],
  ])("rejects %s without creating anything", async (_case, badLine) => {
    const result = await upload(extraction());
    const response = await confirm(result.uploadId, { lines: [badLine] });
    expect(response.status).toBe(400);
    expect(await db.purchaseOrder.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
    expect((await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: result.uploadId } })).status).toBe("pending");
  });

  it("keeps older pending uploads without discount fields readable and confirmable", async () => {
    const legacy = extraction([{ ...extractedLine(), listUnitPriceCents: undefined, lineDiscountPct: undefined, lineDiscountCents: undefined }]);
    const created = await db.purchaseInvoiceUpload.create({ data: { restaurantId: scope.restaurantId, fileUrl: "/uploads/legacy-only.pdf", status: "pending",
      extraction: JSON.parse(JSON.stringify(legacy)) } });
    const reopened = await (await readInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${created.id}`), { params: Promise.resolve({ id: created.id }) })).json();
    expect(reopened.match).not.toBeNull();
    const { listCostCents: _list, discountPct: _pct, discountCents: _value, ...plain } = reviewed();
    void _list; void _pct; void _value;
    const response = await confirm(created.id, { lines: [plain] });
    expect(response.status).toBe(201);
  });
});

describe("supplier discounts entered by hand", () => {
  it("keeps the NET price per presentation in the supplier price history after a discounted reception", async () => {
    const item = await db.supplierIngredient.create({ data: { supplierId, ingredientId, presentationLabel: "Caja x 10", contentQty: 10, lastPriceCents: 1_000_000 } });
    const created = await createOrder(new Request("http://localhost/api/operator/purchase-orders", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ supplierId, lines: [{ ingredientId, supplierItemId: item.id, presentations: 2, expectedCostCents: 2_000_000, taxPct: 19, discountPct: 10 }] }) }));
    expect(created.status).toBe(201);
    const { order } = await created.json();
    const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(po.items[0]).toMatchObject({ listCostCents: 2_000_000, discountCents: 200_000, expectedCostCents: 1_800_000 });
    // Reception with an additional invoice discount: the screen sends the net.
    const received = await receiveOrder(new Request(`http://localhost/api/operator/purchase-orders/${order.id}/receive`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: [{ itemId: po.items[0]!.id, qtyBase: 20, costCents: 1_710_000 }] }) }), { params: Promise.resolve({ id: order.id }) });
    expect(received.status).toBe(200);
    const history = await db.supplierPriceHistory.findMany({ where: { supplierItemId: item.id } });
    expect(history.map(h => h.priceCents)).toEqual([855_000]);
    expect((await db.supplierIngredient.findUniqueOrThrow({ where: { id: item.id } })).lastPriceCents).toBe(855_000);
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, movements: true } });
    // Documentary VAT was null: it follows the real discounted net.
    expect(purchaseOrderTotals(saved, "received")).toMatchObject({ subtotalCents: 1_710_000, taxCents: 324_900, totalCents: 2_034_900 });
    expect(saved.movements[0]).toMatchObject({ valueCents: 1_710_000 });
  });
});
