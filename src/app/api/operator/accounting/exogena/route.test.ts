import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({ getErpContext: async () => ({ restaurantId: "test" }), isDenied: () => false }));
vi.mock("@/lib/db", () => ({ db: {
  purchaseOrder: { findMany: async () => [{
    supplier: { id: "s", name: "Test", taxId: "901944469" },
    incCents: 4_977_400, retefuenteCents: 100, reteIvaCents: 0, reteIcaCents: 0,
    items: [{ expectedCostCents: 8_483_400, receivedCostCents: 8_483_400, expectedTaxCents: 424_200, expectedIncCents: 4_977_400, qtyOrderedBase: 2_000, receivedQtyBase: 2_000, taxPct: 5 }],
  }] },
  expense: { findMany: async () => [] },
} }));
import { GET } from "./route";

describe("legacy supplier export documentary totals", () => {
  it("exports the exact gross including consumption and explicit IVA, separately from withholding", async () => {
    const response = await GET(new Request("http://localhost/api/operator/accounting/exogena?year=2026"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalPagoPesos: 138_850, rows: [{ pagoPesos: 138_850, retefuentePesos: 1 }] });
  });
});
