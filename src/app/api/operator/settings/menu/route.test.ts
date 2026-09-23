import { beforeEach, describe, expect, it, vi } from "vitest";

/** Ajuste "Orden de los platos" del editor de la carta. */
const h = vi.hoisted(() => ({
  update: vi.fn(async () => ({})),
  role: "operator" as string,
  restaurantId: "merchant" as string | null,
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { role: h.role, email: "op@example.test" } }),
}));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => h.restaurantId,
}));
vi.mock("@/lib/db", () => ({ db: { restaurant: { update: h.update } } }));

import { PATCH } from "./route";

const patch = (body: unknown) =>
  PATCH(
    new Request("https://fixture.test/api/operator/settings/menu", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.role = "operator";
  h.restaurantId = "merchant";
});

describe("PATCH /api/operator/settings/menu", () => {
  it.each(["alphabetical", "manual"])("guarda el orden %s en el comercio activo", async (mode) => {
    const res = await patch({ menuItemOrder: mode });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, menuItemOrder: mode });
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "merchant" },
      data: { menuItemOrder: mode },
    });
  });

  it.each([["price"], ["Manual"], [""], [null], [3]])(
    "rechaza un valor desconocido (%j) sin tocar la base",
    async (value) => {
      const res = await patch({ menuItemOrder: value });
      expect(res.status).toBe(400);
      expect(h.update).not.toHaveBeenCalled();
    },
  );

  it("rechaza un cuerpo vacío o que no es JSON", async () => {
    expect((await patch({})).status).toBe(400);
    expect((await patch("no-json")).status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("un mesero no puede cambiarlo", async () => {
    h.role = "mesero";
    const res = await patch({ menuItemOrder: "manual" });
    expect(res.status).toBe(401);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("sin comercio activo no guarda nada", async () => {
    h.restaurantId = null;
    const res = await patch({ menuItemOrder: "manual" });
    expect(res.status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });
});
