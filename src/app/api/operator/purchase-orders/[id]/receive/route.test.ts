// POST /purchase-orders/[id]/receive: la factura de la entrega trae el
// impuesto por línea (IVA y/o consumo) y las retenciones que se practican.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ receivePurchaseOrder: vi.fn(), restaurant: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "user-1", role: "operator" } }) }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", country: "CO" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/purchasing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/erp/purchasing")>()),
  receivePurchaseOrder: m.receivePurchaseOrder,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  },
}));
import { POST } from "./route";
import { PurchasingError } from "@/lib/erp/purchasing";

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://localhost/api/operator/purchase-orders/po-1/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "po-1" }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurant.mockResolvedValue({ purchaseIvaDeductible: false });
  m.receivePurchaseOrder.mockResolvedValue({ purchaseOrder: { id: "po-1", status: "partially_received" }, complete: false });
});

describe("POST /purchase-orders/[id]/receive", () => {
  it("pasa el impuesto de la factura por línea y las retenciones de la entrega", async () => {
    const res = await post({
      lines: [
        { itemId: "it-1", qtyBase: 10, costCents: 100_000, taxPct: 0, incCents: 8_000 },
        { itemId: "it-2", qtyBase: 1, costCents: 50_000 },
      ],
      retefuenteCents: 3_750,
      reteIvaCents: 0,
      reteIcaCents: 1_050,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, order: { id: "po-1", status: "partially_received" }, complete: false });
    expect(m.receivePurchaseOrder).toHaveBeenCalledWith(expect.anything(), {
      restaurantId: "r1",
      purchaseOrderId: "po-1",
      lines: [
        { itemId: "it-1", qtyBase: 10, costCents: 100_000, taxPct: 0, incCents: 8_000 },
        { itemId: "it-2", qtyBase: 1, costCents: 50_000 },
      ],
      ivaDeductible: false,
      retentions: { retefuenteCents: 3_750, reteIvaCents: 0, reteIcaCents: 1_050 },
      createdById: "user-1",
    });
  });

  it("sin retenciones manda ceros (la recepción de siempre)", async () => {
    await post({ lines: [{ itemId: "it-1", qtyBase: 1, costCents: 100 }] });
    expect(m.receivePurchaseOrder.mock.calls[0]![1].retentions).toEqual({ retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0 });
  });

  it("valida tarifas y montos", async () => {
    for (const body of [
      { lines: [{ itemId: "it-1", qtyBase: 1, costCents: 100, taxPct: 101 }] },
      { lines: [{ itemId: "it-1", qtyBase: 1, costCents: 100, incCents: -1 }] },
      { lines: [{ itemId: "it-1", qtyBase: 1, costCents: 100 }], retefuenteCents: -5 },
      { lines: [{ itemId: "it-1", qtyBase: 1, costCents: 100 }], reteIcaCents: 2_000_000_001 },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid" });
    }
    expect(m.receivePurchaseOrder).not.toHaveBeenCalled();
  });

  it.each(["retention_exceeds_base", "retention_exceeds_total", "line_tax_locked"] as const)(
    "%s vuelve como 400 con su código",
    async (code) => {
      m.receivePurchaseOrder.mockRejectedValue(new PurchasingError(code));
      const res = await post({ lines: [{ itemId: "it-1", qtyBase: 1, costCents: 100 }], retefuenteCents: 1 });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: code });
    },
  );
});
