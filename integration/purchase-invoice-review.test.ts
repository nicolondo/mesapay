import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/db";
import { POST as confirmInvoice } from "../src/app/api/operator/purchase-invoices/[id]/confirm/route";
import { DELETE as discardInvoice } from "../src/app/api/operator/purchase-invoices/[id]/route";

const scope = vi.hoisted(() => ({
  restaurantId: "",
  authCalls: 0,
  pauseConfirmation: null as (() => Promise<void>) | null,
}));
// Fix the session boundary while keeping module/tenant validation, purchasing,
// transactions and inventory persistence real. No OCR request is needed.
vi.mock("../src/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("../src/auth", () => ({
  auth: async () => {
    scope.authCalls += 1;
    // Both requests first authenticate in getErpContext. Their next auth call
    // occurs after the upload's pending-state check and before its transaction.
    if (scope.pauseConfirmation && scope.authCalls > 2) {
      await scope.pauseConfirmation();
    }
    return { user: { role: "operator" } };
  },
}));
vi.mock("../src/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => scope.restaurantId }));

const url = new URL(process.env.DATABASE_URL ?? "postgresql://localhost/invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/mesapay_.*(?:test|validation)$/.test(url.pathname)) {
  throw new Error("Isolated local database required");
}

type Mode = "draft" | "receive";
let tenants: string[] = [];
let owner: Awaited<ReturnType<typeof createTenant>>;
let foreign: Awaited<ReturnType<typeof createTenant>>;

async function createTenant() {
  const restaurant = await db.restaurant.create({
    data: {
      name: "Invoice review validation",
      slug: `invoice-review-${randomUUID()}`,
      enabledModules: ["purchasing", "inventory"],
      purchaseIvaDeductible: false,
    },
  });
  tenants = [...tenants, restaurant.id];
  const supplier = await db.supplier.create({
    data: { restaurantId: restaurant.id, name: "Invoice supplier" },
  });
  const original = await db.ingredient.create({
    data: { restaurantId: restaurant.id, name: "Original OCR ingredient", measureKind: "mass" },
  });
  const selected = await db.ingredient.create({
    data: { restaurantId: restaurant.id, name: "Corrected catalog ingredient", measureKind: "count" },
  });
  return { restaurantId: restaurant.id, supplierId: supplier.id, original, selected };
}

beforeEach(async () => {
  scope.authCalls = 0;
  scope.pauseConfirmation = null;
  owner = await createTenant();
  foreign = await createTenant();
  scope.restaurantId = owner.restaurantId;
});

function checkpoint() {
  let release = () => {};
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

describe("concurrent confirmations of the same uploaded invoice", () => {
  it.each(["existing", "new"] as const)("creates one order and one receipt with %s catalog records", async (catalog) => {
    const upload = await uploadInvoice();
    const review = {
      mode: "receive",
      supplierId: catalog === "existing" ? owner.supplierId : null,
      newSupplierName: "Concurrent invoice supplier",
      lines: [{
        ingredientId: catalog === "existing" ? owner.selected.id : null,
        newIngredientName: "Concurrent invoice ingredient",
        newIngredientMeasureKind: "count",
        qtyBase: 3500,
        expectedCostCents: 98001,
        taxPct: 5,
      }],
    };
    const bothPrechecks = checkpoint();
    const gates = [checkpoint(), checkpoint()];
    let arrivals = 0;
    scope.pauseConfirmation = async () => {
      const gate = gates[arrivals++];
      if (arrivals === 2) bothPrechecks.release();
      await gate.reached;
    };
    const attempts = [confirm(upload.id, review), confirm(upload.id, review)];
    const settled = Promise.allSettled(attempts);
    await bothPrechecks.reached;
    // Both requests have already observed pending. Committing the first before
    // resuming the second exposes a stale precheck without timing or DB mocks.
    gates[0].release();
    try {
      await Promise.race(attempts);
    } finally {
      gates[1].release();
    }
    const outcomes = await settled;
    scope.pauseConfirmation = null;

    const orders = await db.purchaseOrder.findMany({
      where: { restaurantId: owner.restaurantId },
      include: { items: true },
    });
    expect(orders).toHaveLength(1);
    const order = orders[0];
    expect(order.status).toBe("received");
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      qtyOrderedBase: 3500, receivedQtyBase: 3500,
      expectedCostCents: 98001, receivedCostCents: 98001, taxPct: 5,
    });
    expect(await db.stockMovement.findMany({ where: { restaurantId: owner.restaurantId } })).toEqual([
      expect.objectContaining({ purchaseOrderId: order.id, ingredientId: order.items[0].ingredientId, kind: "purchase_in", qtyBase: 3500, valueCents: 102901 }),
    ]);
    expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: order.items[0].ingredientId } })).toMatchObject({ qtyBase: 3500, totalValueCents: 102901 });
    expect(await db.supplier.count({ where: { restaurantId: owner.restaurantId } })).toBe(catalog === "new" ? 2 : 1);
    expect(await db.ingredient.count({ where: { restaurantId: owner.restaurantId } })).toBe(catalog === "new" ? 3 : 2);
    expect(await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: upload.id } })).toMatchObject({ status: "confirmed", purchaseOrderId: order.id });
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status !== "fulfilled") throw outcome.reason;
      const response = outcome.value;
      const body = await response.json();
      if (response.status === 201) expect(body.order.id).toBe(order.id);
      else {
        expect(response.status).toBe(409);
        expect(body).toMatchObject({ error: "not_pending" });
      }
    }
    expect(outcomes.some((outcome) => outcome.status === "fulfilled" && outcome.value.status === 201)).toBe(true);
  });
});

describe("concurrent confirmation and discard of an uploaded invoice", () => {
  it("rejects a stale discard after confirmation and preserves the committed order", async () => {
    const upload = await uploadInvoice();
    const discardRead = checkpoint();
    const resumeDiscard = checkpoint();
    const findUnique = db.purchaseInvoiceUpload.findUnique.bind(db.purchaseInvoiceUpload);
    // This is the DELETE's real PostgreSQL read. Only its delivery is delayed;
    // subsequent reads and all writes, including confirmation, stay real.
    const readSpy = vi.spyOn(db.purchaseInvoiceUpload, "findUnique").mockImplementation(findUnique).mockImplementationOnce((args) => {
      return (async () => {
        const record = await findUnique(args);
        discardRead.release();
        await resumeDiscard.reached;
        return record;
      })() as ReturnType<typeof findUnique>;
    });
    const discard = discardInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${upload.id}`, {
      method: "DELETE",
    }), { params: Promise.resolve({ id: upload.id }) });
    try {
      await discardRead.reached;
      const confirmation = await confirm(upload.id, correctedReview("receive"));
      expect(confirmation.status).toBe(201);
      const { order } = await confirmation.json();
      const committedOrder = await db.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id }, include: { items: true, movements: true },
      });
      expect(committedOrder.status).toBe("received");
      resumeDiscard.release();
      const response = await discard;
      const savedUpload = await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: upload.id } });
      expect({ httpStatus: response.status, uploadStatus: savedUpload.status, purchaseOrderId: savedUpload.purchaseOrderId }).toEqual({
        httpStatus: 409, uploadStatus: "confirmed", purchaseOrderId: order.id,
      });
      expect(await db.purchaseOrder.findUniqueOrThrow({
        where: { id: order.id }, include: { items: true, movements: true },
      })).toEqual(committedOrder);
    } finally {
      resumeDiscard.release();
      await discard;
      readSpy.mockRestore();
      // Prisma exposes delegate methods through a Proxy descriptor without a
      // value. Restore the captured real method after Vitest restores that descriptor.
      db.purchaseInvoiceUpload.findUnique = findUnique;
    }
  });
});

afterAll(async () => {
  await db.purchaseOrder.deleteMany({ where: { restaurantId: { in: tenants } } });
  await db.restaurant.deleteMany({ where: { id: { in: tenants } } });
  await db.$disconnect();
});

async function uploadInvoice() {
  return db.purchaseInvoiceUpload.create({
    data: {
      restaurantId: owner.restaurantId,
      fileUrl: "/uploads/synthetic-invoice-review.pdf",
      extraction: {
        documentType: "factura",
        supplierName: "Invoice supplier",
        supplierNit: null,
        supplierInvoiceNumber: "OCR-123",
        issueDate: "2026-10-15",
        currency: "COP",
        lines: [
          { description: owner.original.name, quantity: 2, unit: "kg", unitPriceCents: 20000, lineTotalCents: 40000, taxPct: "19", confidence: 0.9 },
          { description: "Incorrect OCR name", quantity: 1, unit: "und", unitPriceCents: 1000, lineTotalCents: 1000, taxPct: "0", confidence: 0.5 },
        ],
        invoiceSubtotalCents: 41000,
        invoiceTaxCents: 7600,
        invoiceTotalCents: 48600,
        invoiceIncCents: null,
        retefuenteCents: null,
        reteIvaCents: null,
        reteIcaCents: null,
        confidence: 0.7,
        notes: "Synthetic OCR fixture",
      },
    },
  });
}

function correctedReview(mode: Mode) {
  return {
    supplierId: owner.supplierId,
    supplierInvoiceNumber: "REVIEWED-456",
    mode,
    lines: [
      { ingredientId: owner.selected.id, qtyBase: 3500, expectedCostCents: 98001, taxPct: 5 },
      { ingredientId: null, newIngredientName: "Corrected new ingredient", newIngredientMeasureKind: "mass", qtyBase: 7250, expectedCostCents: 123457, taxPct: 19 },
    ],
  };
}

function confirm(uploadId: string, review: unknown) {
  return confirmInvoice(new Request(`http://localhost/api/operator/purchase-invoices/${uploadId}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(review),
  }), { params: Promise.resolve({ id: uploadId }) });
}

async function expectRejectedWithoutWrites(uploadId: string, response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error });
  expect(await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: uploadId } })).toMatchObject({
    restaurantId: owner.restaurantId,
    status: "pending",
    purchaseOrderId: null,
  });
  const restaurantIds = [owner.restaurantId, foreign.restaurantId];
  expect(await db.purchaseOrder.count({ where: { restaurantId: { in: restaurantIds } } })).toBe(0);
  expect(await db.stockMovement.count({ where: { restaurantId: { in: restaurantIds } } })).toBe(0);
  expect(await db.stockLevel.count({ where: { restaurantId: { in: restaurantIds } } })).toBe(0);
  expect(await db.ingredient.count({ where: { restaurantId: owner.restaurantId } })).toBe(2);
  expect(await db.ingredient.count({ where: { restaurantId: foreign.restaurantId } })).toBe(2);
  expect(await db.supplier.count({ where: { restaurantId: { in: restaurantIds } } })).toBe(2);
}

describe.each(["draft", "receive"] as const)("reviewed purchase invoice confirmation (%s) on PostgreSQL", (mode) => {
  it("persists corrected catalog selection, new ingredient, quantity, net cost and VAT instead of OCR values", async () => {
    const upload = await uploadInvoice();
    const response = await confirm(upload.id, correctedReview(mode));
    const body = await response.json();
    expect(body, `HTTP ${response.status}`).toHaveProperty("order.id");
    expect(response.status).toBe(201);

    // Read committed rows independently of the response, which can precede
    // reception updates. The original OCR values intentionally differ.
    const order = await db.purchaseOrder.findUniqueOrThrow({
      where: { id: body.order.id },
      include: { items: { include: { ingredient: true } } },
    });
    expect(order).toMatchObject({
      restaurantId: owner.restaurantId,
      supplierId: owner.supplierId,
      status: mode === "receive" ? "received" : "draft",
    });
    expect(order.items).toHaveLength(2);
    const selected = order.items.find((item) => item.ingredientId === owner.selected.id);
    const created = order.items.find((item) => item.ingredient.name === "Corrected new ingredient");
    expect(selected).toMatchObject({
      qtyOrderedBase: 3500, expectedCostCents: 98001, taxPct: 5,
      ingredient: { restaurantId: owner.restaurantId, name: owner.selected.name, measureKind: "count" },
    });
    expect(created).toMatchObject({
      qtyOrderedBase: 7250, expectedCostCents: 123457, taxPct: 19,
      ingredient: { restaurantId: owner.restaurantId, name: "Corrected new ingredient", measureKind: "mass" },
    });
    expect(order.items.map((item) => item.ingredientId)).not.toContain(owner.original.id);
    expect(await db.ingredient.findUniqueOrThrow({ where: { id: owner.original.id } })).toEqual(owner.original);
    expect(await db.purchaseInvoiceUpload.findUniqueOrThrow({ where: { id: upload.id } })).toMatchObject({
      status: "confirmed", purchaseOrderId: order.id, extraction: upload.extraction,
    });
    expect(await db.purchaseOrder.count({ where: { restaurantId: foreign.restaurantId } })).toBe(0);
    expect(await db.stockMovement.count({ where: { restaurantId: foreign.restaurantId } })).toBe(0);
    expect(await db.ingredient.count({ where: { restaurantId: foreign.restaurantId } })).toBe(2);

    if (mode === "receive") {
      expect(selected).toMatchObject({ receivedQtyBase: 3500, receivedCostCents: 98001 });
      expect(created).toMatchObject({ receivedQtyBase: 7250, receivedCostCents: 123457 });
      const movements = await db.stockMovement.findMany({ where: { purchaseOrderId: order.id } });
      expect(movements).toHaveLength(2);
      // Non-deductible VAT: 98,001 + 4,900 and 123,457 + 23,457.
      expect(movements).toEqual(expect.arrayContaining([
        expect.objectContaining({ restaurantId: owner.restaurantId, ingredientId: selected!.ingredientId, kind: "purchase_in", qtyBase: 3500, valueCents: 102901 }),
        expect.objectContaining({ restaurantId: owner.restaurantId, ingredientId: created!.ingredientId, kind: "purchase_in", qtyBase: 7250, valueCents: 146914 }),
      ]));
      expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: selected!.ingredientId } })).toMatchObject({ qtyBase: 3500, totalValueCents: 102901 });
      expect(await db.stockLevel.findUniqueOrThrow({ where: { ingredientId: created!.ingredientId } })).toMatchObject({ qtyBase: 7250, totalValueCents: 146914 });
    } else {
      expect(order.items.every((item) => item.receivedQtyBase === 0 && item.receivedCostCents === 0)).toBe(true);
      expect(await db.stockMovement.count({ where: { restaurantId: owner.restaurantId } })).toBe(0);
      expect(await db.stockLevel.count({ where: { restaurantId: owner.restaurantId } })).toBe(0);
    }
  });

  it("rejects confirming another tenant's upload without creating catalog or purchase records", async () => {
    const upload = await uploadInvoice();
    scope.restaurantId = foreign.restaurantId;
    const response = await confirm(upload.id, {
      ...correctedReview(mode),
      supplierId: foreign.supplierId,
      lines: [{ ingredientId: foreign.selected.id, qtyBase: 3500, expectedCostCents: 98001, taxPct: 5 }],
    });
    await expectRejectedWithoutWrites(upload.id, response, 404, "not_found");
  });

  it("rejects another tenant's supplier without saving the review", async () => {
    const upload = await uploadInvoice();
    const response = await confirm(upload.id, { ...correctedReview(mode), supplierId: foreign.supplierId });
    await expectRejectedWithoutWrites(upload.id, response, 400, "supplier_not_found");
  });

  it("rolls back new supplier and ingredient rows when a later line references another tenant", async () => {
    const upload = await uploadInvoice();
    const review = correctedReview(mode);
    const response = await confirm(upload.id, {
      ...review,
      supplierId: null,
      newSupplierName: "Must roll back supplier",
      lines: [
        review.lines[1],
        { ingredientId: foreign.selected.id, qtyBase: 3500, expectedCostCents: 98001, taxPct: 5 },
      ],
    });
    await expectRejectedWithoutWrites(upload.id, response, 400, "ingredient_not_found");
  });
});
