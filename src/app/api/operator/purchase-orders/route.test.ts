// POST /purchase-orders: «Nueva orden» con impuesto al consumo por línea y,
// con «Ya recibí esta mercancía», recibida de una vez con la factura y sus
// retenciones (mismo camino que «Recibir mercancía»).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  createPurchaseOrder: vi.fn(),
  receivePurchaseOrder: vi.fn(),
  poUpdate: vi.fn(),
  restaurant: vi.fn(),
  assertPurchase: vi.fn(),
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
// La detección de facturas repetidas se prueba contra PostgreSQL en
// integration/supplier-document-duplicates.test.ts; aquí sólo el cableado.
vi.mock("@/lib/erp/duplicateDocuments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/erp/duplicateDocuments")>()),
  assertNotDuplicatePurchase: m.assertPurchase,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({ purchaseOrder: { update: m.poUpdate } }),
  },
}));
import { POST } from "./route";
import { PurchasingError } from "@/lib/erp/purchasing";
import { DuplicateDocumentError } from "@/lib/erp/duplicateDocuments";

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
  m.assertPurchase.mockResolvedValue(undefined);
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
    // Ya escrita, se revisa que esa factura del proveedor no esté registrada.
    expect(m.assertPurchase).toHaveBeenCalledWith(expect.anything(), {
      restaurantId: "r1",
      purchaseOrderId: "po-1",
      supplierId: "s1",
      number: "FE-123",
      possibleDuplicate: undefined,
    });
  });

  it("una orden que sólo se pide (sin «Ya recibí») no es una factura: no se revisa", async () => {
    await post({ supplierId: "s1", lines: [line] });
    expect(m.assertPurchase).not.toHaveBeenCalled();
  });

  it("factura repetida → 409 con el documento existente (la transacción se revierte)", async () => {
    const existing = {
      kind: "purchase" as const, id: "po-0", number: "FE-0123", purchaseNumber: 3, date: "2026-11-01T17:00:00.000Z",
      totalCents: 240_000, supplierName: "Distribuidora", href: "/operator/compras?oc=po-0",
    };
    m.assertPurchase.mockRejectedValue(new DuplicateDocumentError("duplicate_document", existing));
    const res = await post({ supplierId: "s1", lines: [line], receive: { supplierInvoiceNumber: "FE 123" } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "duplicate_document", duplicate: existing });
  });

  it("sin número pasa la advertencia que pidió el cliente (check / allow)", async () => {
    await post({ supplierId: "s1", lines: [line], receive: {}, possibleDuplicate: "check" });
    expect(m.assertPurchase.mock.calls[0]![1]).toMatchObject({ number: undefined, possibleDuplicate: "check" });
    expect((await post({ supplierId: "s1", lines: [line], receive: {}, possibleDuplicate: "otro" })).status).toBe(400);
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
