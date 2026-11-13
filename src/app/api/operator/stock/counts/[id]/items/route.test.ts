import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/operator/stock/counts/[id]/items — la puerta de entrada:
// autorización, módulo, cuerpo y traducción de errores. Las reglas del
// conteo (etapas, revisión, snapshot) se prueban en stockCounts.append.test.ts.
const m = vi.hoisted(() => ({ auth: vi.fn(), activeRestaurant: vi.fn(), restaurant: vi.fn(), append: vi.fn() }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.activeRestaurant }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant } } }));
vi.mock("@/lib/erp/stockCounts", () => {
  class StockCountError extends Error { constructor(public code: string, public status = 409) { super(code); } }
  return { StockCountError, appendStockCountItem: m.append };
});

import { StockCountError } from "@/lib/erp/stockCounts";
import { POST } from "./route";

const call = (body: unknown, id = "count-1") => POST(
  new Request(`http://localhost/api/operator/stock/counts/${id}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);
const valid = { revision: 3, ingredientId: "ingredient-9" };

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "operator-1", role: "operator" } });
  m.activeRestaurant.mockResolvedValue("restaurant-1");
  m.restaurant.mockResolvedValue({ enabledModules: ["inventory"], country: "CO" });
  m.append.mockResolvedValue({ count: { id: "count-1", revision: 4, items: [] }, itemId: "item-9", added: true });
});

describe("agregar un insumo a un conteo: autorización", () => {
  it.each(["operator", "platform_admin", "group_admin"])("permite a %s con inventario, dentro de su comercio", async (role) => {
    m.auth.mockResolvedValue({ user: { id: "u", role } });
    const response = await call(valid);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: { id: "count-1", revision: 4, items: [] }, itemId: "item-9", added: true });
    expect(m.append).toHaveBeenCalledWith("restaurant-1", "count-1", valid);
  });

  it.each([null, "mesero", "kitchen", "bar", "terminal", "diner"])("rechaza el rol %s sin tocar el conteo", async (role) => {
    m.auth.mockResolvedValue(role ? { user: { role } } : null);
    const response = await call(valid);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(m.append).not.toHaveBeenCalled();
  });

  it.each([[[]], [["purchasing"]], [["recipes", "accounting"]]])("exige el módulo de inventario: %j", async (modules) => {
    m.restaurant.mockResolvedValue({ enabledModules: modules, country: "CO" });
    const response = await call(valid);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "module_disabled" });
    expect(m.append).not.toHaveBeenCalled();
  });

  it("exige un comercio activo", async () => {
    m.activeRestaurant.mockResolvedValue(null);
    expect((await call(valid)).status).toBe(400);
    expect(m.append).not.toHaveBeenCalled();
  });
});

describe("agregar un insumo a un conteo: cuerpo y errores", () => {
  it.each([
    null, [], {}, "{", { revision: 3 }, { ingredientId: "x" }, { revision: -1, ingredientId: "x" }, { revision: 1.5, ingredientId: "x" },
    { revision: "3", ingredientId: "x" }, { revision: 3, ingredientId: "" }, { revision: 3, ingredientId: 9 },
    { revision: 3, ingredientId: "x".repeat(65) }, { revision: 3, ingredientId: "x", restaurantId: "other" }, { revision: 3, ingredientId: "x", expectedQty: 5 },
  ])("rechaza cuerpos mal formados o con campos ajenos: %j", async (body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid" });
    expect(m.append).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404], ["ingredient_not_found", 404], ["count_changed", 409], ["already_closed", 409],
    ["recount_required", 409], ["count_not_editable", 409], ["ingredient_inactive", 409], ["ingredient_not_tracked", 409],
  ])("devuelve %s con su estado HTTP", async (code, status) => {
    m.append.mockRejectedValue(new StockCountError(code, status));
    const response = await call(valid);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  it("no disfraza una falla de la base como error del conteo", async () => {
    const failure = new Error("storage unavailable");
    m.append.mockRejectedValue(failure);
    await expect(call(valid)).rejects.toBe(failure);
  });
});
