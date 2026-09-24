// Lo editable de una impresora desde la web: apagarla y decir si imprime
// QR. Lo que se blinda es que el `supportsQr` se guarda solo (sin tocar
// `active`), que un body vacío no pasa y que la impresora de otro
// comercio es 404.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  activeRestaurantId: vi.fn(),
  printerFindFirst: vi.fn(),
  printerUpdate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: m.activeRestaurantId,
}));
vi.mock("@/lib/db", () => ({
  db: {
    printer: { findFirst: m.printerFindFirst, update: m.printerUpdate },
  },
}));

import { PATCH } from "./route";

const call = (body: unknown) =>
  PATCH(
    new Request("http://localhost/api/operator/printers/p-caja", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "p-caja" }) },
  ) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "u", role: "operator" } });
  m.activeRestaurantId.mockResolvedValue("rest-1");
  m.printerFindFirst.mockResolvedValue({ id: "p-caja" });
  m.printerUpdate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: "p-caja",
    active: args.data.active ?? true,
    supportsQr: args.data.supportsQr ?? false,
  }));
});

describe("la puerta", () => {
  it.each([undefined, "mesero", "kitchen"])("el rol %s no puede (403)", async (role) => {
    m.auth.mockResolvedValue(role ? { user: { role } } : null);
    expect((await call({ supportsQr: true })).status).toBe(403);
    expect(m.printerUpdate).not.toHaveBeenCalled();
  });

  it("la impresora de otro comercio es 404 (se busca acotada al comercio)", async () => {
    m.printerFindFirst.mockResolvedValue(null);
    const res = await call({ supportsQr: true });
    expect(res.status).toBe(404);
    expect(m.printerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p-caja", restaurantId: "rest-1" } }),
    );
    expect(m.printerUpdate).not.toHaveBeenCalled();
  });
});

describe("qué se guarda", () => {
  it("un body sin nada que cambiar ⇒ 400", async () => {
    expect((await call({})).status).toBe(400);
    expect(m.printerUpdate).not.toHaveBeenCalled();
  });

  it("supportsQr solo: no toca active", async () => {
    const res = await call({ supportsQr: true });
    expect(res.status).toBe(200);
    expect(m.printerUpdate).toHaveBeenCalledWith({
      where: { id: "p-caja" },
      data: { supportsQr: true },
      select: { id: true, active: true, supportsQr: true },
    });
    expect(await res.json()).toEqual({
      ok: true,
      printer: { id: "p-caja", active: true, supportsQr: true },
    });
  });

  it("active solo (lo que ya mandaba la pantalla): no toca supportsQr", async () => {
    await call({ active: false });
    expect(m.printerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } }),
    );
  });

  it("los dos juntos", async () => {
    await call({ active: true, supportsQr: false });
    expect(m.printerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: true, supportsQr: false } }),
    );
  });
});
