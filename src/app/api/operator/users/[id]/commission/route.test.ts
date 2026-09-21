import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/operator/users/[id]/commission: el % del mesero entra como
 * porcentaje (0..100, dos decimales) y se guarda en puntos base. Se prueba
 * la conversión, la validación y los dos guardias (rol y tenant).
 */
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  activeRestaurant: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(async () => undefined),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.activeRestaurant }));
vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: m.userFindUnique, update: m.userUpdate } },
}));
import { PUT } from "./route";

const put = (body: unknown, id = "w-ana") =>
  PUT(
    new Request(`http://localhost/api/operator/users/${id}/commission`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ user: { id: "op-1", role: "operator" } });
  m.activeRestaurant.mockResolvedValue("r1");
  m.userFindUnique.mockResolvedValue({ id: "w-ana", role: "mesero", restaurantId: "r1" });
});

describe("PUT /api/operator/users/[id]/commission", () => {
  it.each([
    [2.5, 250],
    [0, 0],
    [100, 10_000],
    [0.333, 33],
    [12.34, 1_234],
  ])("guarda %s %% como %s bps", async (pct, bps) => {
    const res = await put({ commissionPct: pct });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, commissionBps: bps });
    expect(m.userUpdate).toHaveBeenCalledWith({
      where: { id: "w-ana" },
      data: { waiterCommissionBps: bps },
    });
  });

  it("null quita la comisión", async () => {
    const res = await put({ commissionPct: null });
    expect(await res.json()).toEqual({ ok: true, commissionBps: null });
    expect(m.userUpdate).toHaveBeenCalledWith({
      where: { id: "w-ana" },
      data: { waiterCommissionBps: null },
    });
  });

  // (NaN no entra: JSON.stringify lo serializa como null, que sí es válido.)
  it.each([[-1], [100.01], [150], ["2.5"], [true], [undefined]])(
    "rechaza %s con 400 sin escribir",
    async (pct) => {
      const res = await put(pct === undefined ? {} : { commissionPct: pct });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid" });
      expect(m.userUpdate).not.toHaveBeenCalled();
    },
  );

  it("cuerpo que no es JSON → 400", async () => {
    expect((await put("{nope")).status).toBe(400);
    expect(m.userUpdate).not.toHaveBeenCalled();
  });

  it("sólo operator / platform_admin", async () => {
    m.auth.mockResolvedValue({ user: { id: "w-luis", role: "mesero" } });
    expect((await put({ commissionPct: 5 })).status).toBe(403);
    m.auth.mockResolvedValue(null);
    expect((await put({ commissionPct: 5 })).status).toBe(403);
    expect(m.userUpdate).not.toHaveBeenCalled();
  });

  it("un mesero de OTRO restaurante no existe para este operador (404)", async () => {
    m.userFindUnique.mockResolvedValue({ id: "w-ana", role: "mesero", restaurantId: "r2" });
    expect((await put({ commissionPct: 5 })).status).toBe(404);
    m.userFindUnique.mockResolvedValue(null);
    expect((await put({ commissionPct: 5 })).status).toBe(404);
    expect(m.userUpdate).not.toHaveBeenCalled();
  });

  it("sólo usuarios con rol mesero llevan comisión de ventas", async () => {
    m.userFindUnique.mockResolvedValue({ id: "op-2", role: "operator", restaurantId: "r1" });
    const res = await put({ commissionPct: 5 }, "op-2");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "only_mesero_supported" });
    expect(m.userUpdate).not.toHaveBeenCalled();
  });

  it("sin restaurante activo → 400", async () => {
    m.activeRestaurant.mockResolvedValue(null);
    expect((await put({ commissionPct: 5 })).status).toBe(400);
  });
});
