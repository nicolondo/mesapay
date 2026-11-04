// GET /purchase-orders/tax-context: conceptos ACTIVOS + UVT del año para
// sugerir las retenciones de una compra manual, con el gate de Compras.
import { afterEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ concepts: vi.fn(), config: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async (gate: string[]) => (gate.includes("purchasing") ? { restaurantId: "r1", country: "CO" } : { error: "module_disabled", status: 403 }),
  isDenied: (ctx: object) => "error" in ctx,
}));
vi.mock("@/lib/erp/retenciones", () => ({ loadRetentionConcepts: m.concepts }));
vi.mock("@/lib/erp/cierre", () => ({ getAccountingConfig: m.config }));
import { GET } from "./route";

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /purchase-orders/tax-context", () => {
  it("devuelve solo los conceptos activos y la UVT del año en curso", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T15:00:00Z"));
    m.concepts.mockResolvedValue([
      { id: "c1", kind: "retefuente", name: "Compras", rateBps: 250, base: "subtotal", thresholdUvt: 27, accountCode: "236505", active: true, restaurantId: "r1" },
      { id: "c2", kind: "retefuente", name: "Servicios", rateBps: 400, base: "subtotal", thresholdUvt: 4, accountCode: "236505", active: false, restaurantId: "r1" },
    ]);
    m.config.mockResolvedValue({ uvtCents: 9_999_900, closedThrough: null, nextVoucherNumber: 1 });
    const res = await GET(new Request("http://localhost/api/operator/purchase-orders/tax-context"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.concepts).toEqual([
      { id: "c1", kind: "retefuente", name: "Compras", rateBps: 250, base: "subtotal", thresholdUvt: 27, accountCode: "236505" },
    ]);
    // 2026 está en la tabla oficial: $52.374, no la del ajuste.
    expect(body.uvtCents).toBe(5_237_400);
  });
});
