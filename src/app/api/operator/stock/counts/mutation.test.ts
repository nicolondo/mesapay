import { beforeEach, describe, expect, it, vi } from "vitest";

// Puerta de entrada de las acciones de etapa del conteo: autorización,
// cuerpo por acción (incluido «Recontar todo») y traducción de errores.
const m = vi.hoisted(() => ({ auth: vi.fn(), activeRestaurant: vi.fn(), restaurant: vi.fn(), mutate: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.activeRestaurant }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.restaurant } } }));
vi.mock("@/lib/erp/stockCounts", () => {
  class StockCountError extends Error { constructor(public code: string, public status = 409) { super(code); } }
  return { StockCountError, mutateStockCount: m.mutate };
});

import { StockCountError } from "@/lib/erp/stockCounts";
import { countMutation } from "./mutation";

const call = (action: Parameters<typeof countMutation>[0], body: unknown) => countMutation(action)(
  new Request("http://localhost/api/operator/stock/counts/count-1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "count-1" }) },
);

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "operator-1", role: "operator" } });
  m.activeRestaurant.mockResolvedValue("restaurant-1");
  m.restaurant.mockResolvedValue({ enabledModules: ["inventory"], country: "CO" });
  m.mutate.mockResolvedValue({ count: { id: "count-1", revision: 5 } });
});

describe("iniciar el conteo definitivo", () => {
  it("por defecto arrastra lo confirmado: no manda `full`", async () => {
    const response = await call("recount", { revision: 4 });
    expect(response.status).toBe(200);
    expect(m.mutate).toHaveBeenCalledWith("restaurant-1", "count-1", "recount", { revision: 4 }, null);
  });

  it("«Recontar todo» manda `full: true`", async () => {
    expect((await call("recount", { revision: 4, full: true })).status).toBe(200);
    expect(m.mutate).toHaveBeenCalledWith("restaurant-1", "count-1", "recount", { revision: 4, full: true }, null);
  });

  it.each([{ revision: 4, full: "yes" }, { revision: 4, full: 1 }, { full: true }, { revision: -1 }, null])("rechaza cuerpos mal formados: %j", async (body) => {
    const response = await call("recount", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid" });
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it("las demás acciones no reciben `full`", async () => {
    await call("preliminary", { revision: 4, full: true });
    expect(m.mutate).toHaveBeenCalledWith("restaurant-1", "count-1", "preliminary", { revision: 4 }, null);
  });

  it.each([null, "mesero", "kitchen", "diner"])("rechaza el rol %s", async (role) => {
    m.auth.mockResolvedValue(role ? { user: { role } } : null);
    expect((await call("recount", { revision: 4 })).status).toBe(401);
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it("exige el módulo de inventario", async () => {
    m.restaurant.mockResolvedValue({ enabledModules: ["recipes"], country: "CO" });
    expect((await call("recount", { revision: 4, full: true })).status).toBe(403);
    expect(m.mutate).not.toHaveBeenCalled();
  });

  it("devuelve los errores del conteo con su estado", async () => {
    m.mutate.mockRejectedValue(new StockCountError("preliminary_required"));
    const response = await call("recount", { revision: 4 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "preliminary_required" });
  });
});
