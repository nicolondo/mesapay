// POST /purchase-invoices/[id]/confirm: los descuentos del proveedor viajan
// como lista + descuento y solo se aceptan si reproducen el neto revisado.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  createPurchaseOrder: vi.fn(),
  receivePurchaseOrder: vi.fn(),
  transaction: vi.fn(),
  uploadFind: vi.fn(),
  orderUpdate: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "user-1", role: "operator" } }) }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/invoiceAliases", () => ({
  InvoiceAliasError: class extends Error {},
  rememberInvoiceAliases: async () => {},
}));
vi.mock("@/lib/erp/purchasing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/erp/purchasing")>()),
  createPurchaseOrder: m.createPurchaseOrder,
  receivePurchaseOrder: m.receivePurchaseOrder,
}));
const tx = {
  purchaseInvoiceUpload: { updateMany: async () => ({ count: 1 }), update: async () => ({}) },
  supplier: { findUnique: async () => ({ restaurantId: "r1" }) },
  ingredient: { findUnique: async () => ({ restaurantId: "r1" }) },
  purchaseOrder: { update: m.orderUpdate, findUniqueOrThrow: async () => ({ items: [] }) },
};
vi.mock("@/lib/db", () => ({
  db: {
    purchaseInvoiceUpload: { findUnique: m.uploadFind },
    restaurant: { findUnique: async () => ({ purchaseIvaDeductible: false }) },
    $transaction: m.transaction,
  },
}));
import { POST } from "./route";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/operator/purchase-invoices/up-1/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "up-1" }) },
  );

const line = (fields: Record<string, unknown> = {}) => ({
  ingredientId: "ing-1", qtyBase: 2_000, expectedCostCents: 1_800_000, taxPct: 19,
  expectedTaxCents: 342_000, expectedIncCents: 0, ...fields,
});
const body = (lines: Record<string, unknown>[], fields: Record<string, unknown> = {}) =>
  ({ supplierId: "sup-1", mode: "draft", lines, ...fields });

beforeEach(() => {
  vi.resetAllMocks();
  m.uploadFind.mockResolvedValue({ id: "up-1", restaurantId: "r1", status: "pending" });
  m.transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
  m.createPurchaseOrder.mockResolvedValue({ id: "po-1" });
});

describe("confirming an imported invoice with supplier discounts", () => {
  it("hands list price and discounts to the purchase order, which re-derives the reviewed net", async () => {
    const response = await post(body([
      line({ listCostCents: 2_000_000, discountPct: 10, discountCents: null, expectedCostCents: 1_710_000, expectedTaxCents: 324_900 }),
      line({ ingredientId: "ing-2", listCostCents: 1_000_000, discountPct: null, discountCents: null, expectedCostCents: 950_000, expectedTaxCents: 180_500 }),
    ], { discountPct: 5, discountCents: null }));
    expect(response.status).toBe(201);
    const args = m.createPurchaseOrder.mock.calls[0]![1];
    expect(args).toMatchObject({ discountPct: 5, discountCents: null });
    expect(args.lines).toEqual([
      expect.objectContaining({ expectedCostCents: 2_000_000, discountPct: 10, discountCents: null, expectedTaxCents: 324_900 }),
      expect.objectContaining({ expectedCostCents: 1_000_000, discountPct: null, discountCents: null, expectedTaxCents: 180_500 }),
    ]);
  });

  it.each([
    ["a net that already contains the discount", [line({ listCostCents: 1_800_000, discountPct: 10 })], {}],
    ["a list price without a discount", [line({ listCostCents: 2_000_000 })], {}],
    ["a document discount the lines do not reflect", [line()], { discountCents: 10_000 }],
    ["a discount that leaves a different net", [line({ listCostCents: 2_000_000, discountCents: 150_000 })], {}],
  ])("rejects %s before touching the database", async (_case, lines, fields) => {
    const response = await post(body(lines, fields));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid" });
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.createPurchaseOrder).not.toHaveBeenCalled();
  });

  it("keeps the previous contract for invoices without discounts", async () => {
    const response = await post(body([line()]));
    expect(response.status).toBe(201);
    const args = m.createPurchaseOrder.mock.calls[0]![1];
    expect(args).toMatchObject({ discountPct: null, discountCents: null });
    expect(args.lines[0]).toMatchObject({ expectedCostCents: 1_800_000, discountPct: null, discountCents: null });
  });

  it.each([{ discountPct: 101 }, { discountPct: 12.5 }, { discountCents: -1 }])("validates the discount fields %j", async (fields) => {
    expect((await post(body([line({ listCostCents: 2_000_000, ...fields })]))).status).toBe(400);
  });
});

describe("confirming against the printed invoice total", () => {
  // Neto $18.000 + IVA $3.420 + consumo $3.000 − retefuente $450 = $23.970,
  // y la factura imprime «Ajustes −0,32» y un Total de $23.969,68.
  const lines = [line({ expectedIncCents: 300_000 })];
  const totals = { incCents: 300_000, retefuenteCents: 45_000 };
  beforeEach(() => {
    m.uploadFind.mockResolvedValue({ id: "up-1", restaurantId: "r1", status: "pending",
      extraction: { invoiceTotalCents: 2_396_968 } });
  });

  it("stores the printed rounding adjustment on the purchase so the payable equals the invoice Total", async () => {
    const response = await post(body(lines, { ...totals, roundingCents: -32 }));
    expect(response.status).toBe(201);
    expect(m.orderUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ incCents: 300_000, retefuenteCents: 45_000, roundingCents: -32 }),
    }));
  });

  it("refuses a payable that differs from the printed Total without explicit confirmation", async () => {
    const response = await post(body(lines, totals));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "totals_unconfirmed" });
    // Checked inside the (rolled back) transaction, before any purchase is created.
    expect(m.createPurchaseOrder).not.toHaveBeenCalled();
    expect(m.receivePurchaseOrder).not.toHaveBeenCalled();
  });

  it("never hides a tenant validation error behind the totals check", async () => {
    const supplier = vi.spyOn(tx.supplier, "findUnique").mockResolvedValueOnce({ restaurantId: "other-restaurant" });
    try {
      const response = await post(body(lines, totals));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "supplier_not_found" });
    } finally { supplier.mockRestore(); }
  });

  it("saves the reviewed amounts when the operator explicitly accepts the difference", async () => {
    const response = await post(body(lines, { ...totals, acknowledgedDifferences: true }));
    expect(response.status).toBe(201);
  });

  it("does not block uploads that never read a printed total", async () => {
    m.uploadFind.mockResolvedValue({ id: "up-1", restaurantId: "r1", status: "pending", extraction: { invoiceTotalCents: null } });
    expect((await post(body(lines, totals))).status).toBe(201);
  });

  it.each([100_001, -100_001, 0.5])("rejects a rounding adjustment of %s cents", async (roundingCents) => {
    expect((await post(body(lines, { ...totals, roundingCents }))).status).toBe(400);
  });
});
