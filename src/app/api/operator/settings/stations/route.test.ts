import { beforeEach, describe, expect, it, vi } from "vitest";

/** El toggle de marchado automático viaja por la misma rama `print`. */
const h = vi.hoisted(() => ({ update: vi.fn(async () => ({})) }));

vi.mock("@/lib/secureApi", () => ({ secureApi: (fn: unknown) => fn }));
vi.mock("@/auth", () => ({
  auth: async () => ({ user: { role: "operator", email: "op@example.test" } }),
}));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: async () => "merchant",
}));
vi.mock("@/lib/db", () => ({
  db: { restaurant: { update: h.update }, category: {} },
}));

import { PATCH } from "./route";

const patch = (body: unknown) =>
  PATCH(
    new Request("https://fixture.test/api/operator/settings/stations", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => vi.clearAllMocks());

describe("PATCH /api/operator/settings/stations — kind: print", () => {
  it("guarda el marchado automático del bar", async () => {
    const res = await patch({ kind: "print", barAutoFire: true });
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "merchant" },
      data: { barAutoFire: true },
    });
  });

  it("acepta cocina y bar junto con los toggles de impresión", async () => {
    const res = await patch({
      kind: "print",
      kitchenAutoFire: true,
      barAutoFire: false,
      barPrintEnabled: true,
    });
    expect(res.status).toBe(200);
    expect(h.update).toHaveBeenCalledWith({
      where: { id: "merchant" },
      data: { barPrintEnabled: true, kitchenAutoFire: true, barAutoFire: false },
    });
  });

  it("rechaza un valor que no es booleano sin tocar la base", async () => {
    const res = await patch({ kind: "print", barAutoFire: "sí" });
    expect(res.status).toBe(400);
    expect(h.update).not.toHaveBeenCalled();
  });
});
