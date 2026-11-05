import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), supplier: vi.fn(), orders: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: mocks.context,
  isDenied: (ctx: { error?: string }) => !!ctx.error,
}));
vi.mock("@/lib/db", () => ({
  db: {
    supplier: { findUnique: mocks.supplier },
    purchaseOrder: { findMany: mocks.orders },
  },
}));
import { GET } from "./route";

const params = { params: Promise.resolve({ id: "supplier" }) };
const request = () => new Request("http://localhost/api/operator/suppliers/supplier/recent-items");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({ restaurantId: "restaurant" });
  mocks.supplier.mockResolvedValue({ restaurantId: "restaurant" });
  mocks.orders.mockResolvedValue([]);
});

describe("lo que se le suele pedir a un proveedor", () => {
  it("respeta el permiso del módulo de compras", async () => {
    mocks.context.mockResolvedValue({ error: "module_disabled", status: 403 });
    const res = await GET(request(), params);
    expect(res.status).toBe(403);
    expect(mocks.orders).not.toHaveBeenCalled();
  });

  it("no muestra proveedores de otro comercio", async () => {
    mocks.supplier.mockResolvedValue({ restaurantId: "other" });
    const res = await GET(request(), params);
    expect(res.status).toBe(404);
    expect(mocks.orders).not.toHaveBeenCalled();
  });

  it("lee solo órdenes no anuladas de ese proveedor y comercio, y las resume", async () => {
    mocks.orders.mockResolvedValue([
      {
        createdAt: new Date("2026-10-20T12:00:00Z"),
        items: [
          {
            ingredientId: "rice",
            supplierItemId: null,
            presentations: null,
            qtyOrderedBase: 25_000,
            listCostCents: null,
            expectedCostCents: 11_250_000,
            taxPct: 5,
            expectedIncCents: 0,
            ingredient: { active: true },
          },
        ],
      },
    ]);
    const res = await GET(request(), params);
    expect(res.status).toBe(200);
    expect(mocks.orders).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { restaurantId: "restaurant", supplierId: "supplier", status: { not: "canceled" } },
        take: 20,
      }),
    );
    expect(await res.json()).toEqual({
      orderCount: 1,
      items: [
        {
          ingredientId: "rice",
          orders: 1,
          lastOrderedAt: "2026-10-20T12:00:00.000Z",
          supplierItemId: null,
          presentations: null,
          qtyBase: 25_000,
          listCostCents: 11_250_000,
          taxPct: 5,
          incPct: null,
        },
      ],
    });
  });
});
