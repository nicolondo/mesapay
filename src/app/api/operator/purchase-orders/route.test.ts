// POST /purchase-orders: «Nueva orden» con impuesto al consumo por línea y,
// con «Ya recibí esta mercancía», recibida de una vez con la factura y sus
// retenciones (mismo camino que «Recibir mercancía»).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  createPurchaseOrder: vi.fn(),
  receivePurchaseOrder: vi.fn(),
  poUpdate: vi.fn(),
  restaurant: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "user-1", role: "operator" } }) }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", country: "CO" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/purchasing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/erp/purchasing")>()),
  createPurchaseOrder: m.createPurchaseOrder,
  receivePurchaseOrder: m.receivePurchaseOrder,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ purchaseOrder: { update: m.poUpdate } }),
  },
}));
import { POST } from "./route";
import { PurchasingError } from "@/lib/erp/purchasing";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/operator/purchase-orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const line = { ingredientId: "ing-1", qtyBase: 24, expectedCostCents: 240_000, taxPct: 0, expectedIncCents: 19_200 };

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurant.mockResolvedValue({ purchaseIvaDeductible: true });
  m.createPurchaseOrder.mockResolvedValue({
    id: "po-1",
    items: [{ id: "it-1", qtyOrderedBase: 24, expectedCostCents: 240_000 }],
  });
  m.receivePurchaseOrder.mockResolvedValue({ purchaseOrder: { id: "po-1" }, complete: true });
  m.poUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "po-1", status: "received", ...data }));
});

describe("POST /purchase-orders", () => {
  it("una orden normal pasa el consumo de la línea y no recibe nada", async () => {
    const res = await post({ supplierId: "s1", lines: [line] });
    expect(res.status).toBe(201);
    expect(m.createPurchaseOrder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lines: [expect.objectContaining({ expectedIncCents: 19_200, taxPct: 0 })] }),
    );
    expect(m.receivePurchaseOrder).not.toHaveBeenCalled();
  });

  it("«Ya recibí esta mercancía» recibe todo a lo pedido, con las retenciones, y guarda la factura", async () => {
    const res = await post({
      supplierId: "s1",
      lines: [line],
      receive: {
        supplierInvoiceNumber: "FE-123",
        invoiceDueAt: "2026-12-04T17:00:00.000Z",
        retefuenteCents: 6_000,
        reteIcaCents: 1_680,
      },
    });
    expect(res.status).toBe(201);
    expect(m.receivePurchaseOrder).toHaveBeenCalledWith(expect.anything(), {
      restaurantId: "r1",
      purchaseOrderId: "po-1",
      lines: [{ itemId: "it-1", qtyBase: 24, costCents: 240_000 }],
      ivaDeductible: true,
      retentions: { retefuenteCents: 6_000, reteIvaCents: 0, reteIcaCents: 1_680 },
      createdById: "user-1",
    });
    expect(m.poUpdate).toHaveBeenCalledWith({
      where: { id: "po-1" },
      data: { supplierInvoiceNumber: "FE-123", invoiceDueAt: new Date("2026-12-04T17:00:00.000Z") },
    });
    expect((await res.json()).order).toMatchObject({ id: "po-1", supplierInvoiceNumber: "FE-123" });
  });

  it("rechaza retenciones negativas o no enteras", async () => {
    for (const bad of [{ retefuenteCents: -1 }, { reteIvaCents: 1.5 }]) {
      const res = await post({ supplierId: "s1", lines: [line], receive: bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid" });
    }
    expect(m.createPurchaseOrder).not.toHaveBeenCalled();
  });

  it("una retención mayor que su base vuelve con su código (y la transacción se revierte)", async () => {
    m.receivePurchaseOrder.mockRejectedValue(new PurchasingError("retention_exceeds_base"));
    const res = await post({ supplierId: "s1", lines: [line], receive: { retefuenteCents: 999_999 } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "retention_exceeds_base" });
    expect(m.poUpdate).not.toHaveBeenCalled();
  });
});
