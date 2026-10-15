import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(), supplier: vi.fn(), ingredient: vi.fn(), duplicate: vi.fn(),
  create: vi.fn(), updatePreferred: vi.fn(), lock: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({ getErpContext: mocks.context, isDenied: (ctx: { error?: string }) => !!ctx.error }));
vi.mock("@/lib/orderLock", () => ({ lockStock: mocks.lock }));
vi.mock("@/lib/db", () => {
  const tx = {
    supplier: { findUnique: mocks.supplier },
    ingredient: { findUnique: mocks.ingredient },
    supplierIngredient: { findUnique: mocks.duplicate, updateMany: mocks.updatePreferred, create: mocks.create },
  };
  return { db: { ...tx, $transaction: (fn: (client: unknown) => unknown) => fn(tx) } };
});
import { POST } from "./route";

const params = { params: Promise.resolve({ id: "supplier" }) };
const body = { ingredientId: "ingredient", presentationLabel: "Bag", contentQty: 1000, preferred: true };
const request = (payload: unknown = body) => new Request("http://localhost/api/operator/suppliers/supplier/items", {
  method: "POST", body: JSON.stringify(payload),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({ restaurantId: "restaurant" });
  mocks.supplier.mockResolvedValue({ restaurantId: "restaurant" });
  mocks.ingredient.mockResolvedValue({ restaurantId: "restaurant", active: true });
  mocks.duplicate.mockResolvedValue(null);
  mocks.create.mockResolvedValue({ id: "supplier-item" });
});

describe("adding archived ingredients to supplier catalogs", () => {
  it("rejects an archived ingredient without changing preferred suppliers", async () => {
    mocks.ingredient.mockResolvedValue({ restaurantId: "restaurant", active: false });

    const response = await POST(request(), params);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ingredient_inactive" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updatePreferred).not.toHaveBeenCalled();
  });

  it("rechecks archive state after obtaining the stock lock", async () => {
    mocks.lock.mockImplementation(async () => {
      mocks.ingredient.mockResolvedValue({ restaurantId: "restaurant", active: false });
    });

    const response = await POST(request(), params);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ingredient_inactive" });
    expect(mocks.lock).toHaveBeenCalledWith(expect.anything(), "restaurant");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("still adds an active ingredient and updates its preferred supplier", async () => {
    const response = await POST(request(), params);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ item: { id: "supplier-item" } });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining(body) }));
    expect(mocks.updatePreferred).toHaveBeenCalledWith({ where: { ingredientId: "ingredient", preferred: true }, data: { preferred: false } });
  });

  it("rejects ingredients from another restaurant without mutations", async () => {
    mocks.ingredient.mockResolvedValue({ restaurantId: "other", active: true });
    const response = await POST(request(), params);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ingredient_not_found" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updatePreferred).not.toHaveBeenCalled();
  });

  it("retains the duplicate presentation error", async () => {
    mocks.duplicate.mockResolvedValue({ id: "existing" });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "already_listed" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updatePreferred).not.toHaveBeenCalled();
  });

  it("requires ERP access before reading or writing the catalog", async () => {
    mocks.context.mockResolvedValue({ error: "module_disabled", status: 403 });
    expect((await POST(request(), params)).status).toBe(403);
    expect(mocks.supplier).not.toHaveBeenCalled();
    expect(mocks.ingredient).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
