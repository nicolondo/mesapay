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
import { GET as readOrder } from "../src/app/api/operator/purchase-orders/[id]/route";
import { receivePurchaseOrder } from "../src/lib/erp/purchasing";
import { purchaseOrderTotals } from "../src/lib/erp/purchaseTax";
import { inferPurchaseInvoiceTaxBases } from "../src/lib/erp/invoiceTaxBasis";

const scope = vi.hoisted(() => ({ restaurantId: "", extraction: null as PurchaseInvoiceExtraction | null, extract: vi.fn() }));
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({ auth: async () => ({ user: { role: "operator" } }) }));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));
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

function extractedLine(overrides: Partial<PurchaseInvoiceLineType> = {}): PurchaseInvoiceLineType {
  return {
    description: "Botellas de prueba", quantity: 2, unit: "un", unitPriceCents: 1_000_000,
    lineTotalCents: 2_380_000, unitPriceTaxBasis: "net", lineTotalTaxBasis: "unknown",
    taxPct: "19", lineTaxCents: 380_000, lineIncCents: 0, confidence: 1, ...overrides,
  };
}

function extraction(lines = [extractedLine()], totals: Partial<PurchaseInvoiceExtraction> = {}): PurchaseInvoiceExtraction {
  return {
    documentType: "factura", supplierName: "Proveedor de prueba", supplierNit: null,
    supplierInvoiceNumber: `TAX-${randomUUID()}`, issueDate: "2026-10-28", currency: "COP", lines,
    invoiceSubtotalCents: null, invoiceTaxCents: null, invoiceTotalCents: null, invoiceIncCents: 0,
    retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0, confidence: 1, ...totals,
  };
}

beforeAll(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), "mesapay-tax-basis-upload-"));
  process.env.UPLOAD_DIR = uploadDir;
});
beforeEach(async () => {
  const r = await db.restaurant.create({ data: { name: "Tax basis validation", slug: `tax-basis-${randomUUID()}`, enabledModules: ["purchasing", "inventory"], purchaseIvaDeductible: false } });
  tenants.push(r.id);
  scope.restaurantId = r.id;
  supplierId = (await db.supplier.create({ data: { restaurantId: r.id, name: "Proveedor de prueba" } })).id;
  ingredientId = (await db.ingredient.create({ data: { restaurantId: r.id, name: "Botellas de prueba", measureKind: "count" } })).id;
  // Stub only the paid document-reading step; run the same deterministic
  // inference used by extraction before the real upload, match and storage.
  scope.extract.mockReset().mockImplementation(async () => inferPurchaseInvoiceTaxBases(scope.extraction!));
});
afterAll(async () => {
  await db.stockMovement.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
  if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = previousUploadDir;
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

async function upload(raw: PurchaseInvoiceExtraction) {
  scope.extraction = raw;
  const original = structuredClone(raw);
  const form = new FormData();
  form.set("file", new File(["%PDF synthetic tax basis test only"], "invoice.pdf", { type: "application/pdf" }));
  const response = await uploadInvoice(new Request("http://localhost/api/operator/purchase-invoices", { method: "POST", body: form }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(raw, "Inference must not mutate the OCR source object").toEqual(original);
  expect(scope.extract).toHaveBeenCalledTimes(1);
  expect((await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: body.uploadId } })).extraction).toEqual(body.extraction);
  return body as { uploadId: string; extraction: PurchaseInvoiceExtraction; match: { lines: { line: PurchaseInvoiceLineType }[] } };
}

function read(id: string) {
  return readInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${id}`), { params: Promise.resolve({ id }) });
}
function confirm(id: string, mode: "draft" | "receive", lines: Record<string, unknown>[], incCents = 0) {
  return confirmInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${id}/confirm`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ supplierId, mode, incCents, lines }),
  }), { params: Promise.resolve({ id }) });
}

describe("per-line VAT basis on imported supplier invoices", () => {
  it.each([
    { total: 2_380_000, expected: "gross" },
    { total: 2_000_000, expected: "net" },
  ])("persists automatic $expected interpretation and reopens it without another OCR call", async ({ total, expected }) => {
    const result = await upload(extraction([extractedLine({ lineTotalCents: total })]));
    expect(result.extraction.lines[0]).toMatchObject({ lineTotalCents: total, lineTotalTaxBasis: expected, unitPriceTaxBasis: "net" });
    expect(result.match.lines[0].line.lineTotalTaxBasis).toBe(expected);
    const reopened = await (await read(result.uploadId)).json();
    expect(reopened.upload.extraction).toEqual(result.extraction);
    expect(reopened.match.lines[0].line.lineTotalTaxBasis).toBe(expected);
    expect(scope.extract).toHaveBeenCalledTimes(1);
    expect(await db.purchaseOrder.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
  });

  it("detects gross and net lines independently within the same invoice", async () => {
    const result = await upload(extraction([
      extractedLine({ description: "Botellas con IVA" }),
      extractedLine({ description: "Botellas sin IVA", lineTotalCents: 2_000_000 }),
    ], { invoiceSubtotalCents: 4_000_000, invoiceTaxCents: 760_000, invoiceTotalCents: 4_760_000 }));
    expect(result.extraction.lines.map(l => l.lineTotalTaxBasis)).toEqual(["gross", "net"]);
    expect(result.extraction.lines.map(l => l.quantity)).toEqual([2, 2]);
    expect(result.extraction.lines.map(l => l.lineTotalCents)).toEqual([2_380_000, 2_000_000]);
  });

  it("does not turn an unsupported assumption into a confident excluded-tax amount", async () => {
    const raw = extraction([extractedLine({ unitPriceCents: null, unitPriceTaxBasis: "unknown", lineTaxCents: null, lineTotalCents: 2_000_000 })]);
    const result = await upload(raw);
    expect(result.extraction.lines[0].lineTotalTaxBasis).toBe("unknown");
    expect((await (await read(result.uploadId)).json()).match.lines[0].line.lineTotalTaxBasis).toBe("unknown");
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
  });

  it("recognizes final prices that include both VAT and fixed consumption without folding consumption into VAT", async () => {
    const result = await upload(extraction([extractedLine({ taxPct: "5", lineTaxCents: 100_000, lineIncCents: 500_000, lineTotalCents: 2_600_000 })], {
      invoiceSubtotalCents: 2_000_000, invoiceTaxCents: 100_000, invoiceIncCents: 500_000, invoiceTotalCents: 2_600_000,
    }));
    expect(result.extraction.lines[0]).toMatchObject({ lineTotalTaxBasis: "gross", lineTaxCents: 100_000, lineIncCents: 500_000 });
    const response = await confirm(result.uploadId, "receive", [{ ingredientId, qtyBase: 2000, expectedCostCents: 2_000_000, expectedTaxCents: 100_000, expectedIncCents: 500_000, taxPct: 5 }], 500_000);
    expect(response.status).toBe(201);
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { restaurantId: scope.restaurantId }, include: { items: true } });
    expect(purchaseOrderTotals(order, "received").totalCents).toBe(2_600_000);
    expect(await db.stockMovement.findMany({ where: { restaurantId: scope.restaurantId } })).toEqual([
      expect.objectContaining({ qtyBase: 2000, valueCents: 2_600_000 }),
    ]);
  });

  it.each(["draft", "receive"] as const)("honors a manually corrected interpretation through %s, reopening and receipt without applying quantity twice", async mode => {
    const result = await upload(extraction());
    expect(result.extraction.lines[0].lineTotalTaxBasis).toBe("gross");
    // The operator explicitly switched the same 23,800 line amount to BEFORE
    // VAT. These are the reviewed amounts; they must override OCR inference.
    const line = { ingredientId, qtyBase: 2000, expectedCostCents: 2_380_000, expectedTaxCents: 452_200, expectedIncCents: 0, taxPct: 19 };
    const response = await confirm(result.uploadId, mode, [line]);
    expect(response.status).toBe(201);
    const { order } = await response.json();
    const reopened = await readOrder(new Request(`http://localhost/api/operator/purchase-orders/${order.id}`), { params: Promise.resolve({ id: order.id }) });
    expect(reopened.status).toBe(200);
    expect((await reopened.json()).order.items[0]).toMatchObject({ qtyOrderedBase: 2000, expectedCostCents: 2_380_000, expectedTaxCents: 452_200 });
    const saved = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    if (mode === "draft") {
      expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(0);
      await db.$transaction(tx => receivePurchaseOrder(tx, { restaurantId: scope.restaurantId, purchaseOrderId: order.id, lines: [{ itemId: saved.items[0].id, qtyBase: 2000, costCents: 2_380_000 }] }));
    }
    const received = await db.purchaseOrder.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(received.items[0]).toMatchObject({ receivedQtyBase: 2000, receivedCostCents: 2_380_000 });
    expect(purchaseOrderTotals(received, "received").totalCents).toBe(2_832_200);
    expect(await db.stockMovement.findMany({ where: { restaurantId: scope.restaurantId } })).toEqual([
      expect.objectContaining({ qtyBase: 2000, valueCents: 2_832_200 }),
    ]);
    expect((await confirm(result.uploadId, "receive", [line])).status).toBe(409);
    expect(await db.purchaseOrder.count({ where: { restaurantId: scope.restaurantId } })).toBe(1);
    expect(await db.stockMovement.count({ where: { restaurantId: scope.restaurantId } })).toBe(1);
  });
});
