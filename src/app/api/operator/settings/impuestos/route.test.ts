// La puerta del impuesto de ventas: quién puede tocarlo y qué acepta.
//
// El endpoint vivía detrás del módulo `accounting`, y un comercio sin
// contabilidad no podía configurar el impuesto con el que factura. Por eso
// acá corre el getErpContext REAL (con auth y DB mockeadas) en vez de un
// mock del guard: lo que se quiere asegurar es justamente que el gate de
// módulo ya no está y que el de rol sí sigue.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  activeRestaurantId: vi.fn(),
  restaurantFindUnique: vi.fn(),
  restaurantUpdate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveRestaurantId: m.activeRestaurantId,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: {
      findUnique: m.restaurantFindUnique,
      update: m.restaurantUpdate,
    },
  },
}));

import { GET, PATCH } from "./route";
import * as legacy from "@/app/api/operator/accounting/tax-config/route";

const URL = "http://localhost/api/operator/settings/impuestos";

const patch = (body: unknown) =>
  PATCH(
    new Request(URL, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  ) as Promise<Response>;

const get = () => GET(new Request(URL)) as Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { role: "operator" } });
  m.activeRestaurantId.mockResolvedValue("rest-1");
  // Comercio SIN ningún módulo: ni contabilidad ni facturación electrónica.
  m.restaurantFindUnique.mockResolvedValue({
    enabledModules: [],
    country: "CO",
    salesTaxKind: "none",
    salesTaxPct: 0,
  });
  m.restaurantUpdate.mockImplementation(
    async ({ data }: { data: { salesTaxKind?: string; salesTaxPct?: number } }) => ({
      salesTaxKind: data.salesTaxKind ?? "none",
      salesTaxPct: data.salesTaxPct ?? 0,
    }),
  );
});

describe("sin gate de módulo", () => {
  it("un operator sin contabilidad configura su impuesto", async () => {
    const res = await patch({ salesTaxKind: "inc", salesTaxPct: 8 });
    expect(res.status).toBe(200);
    expect(m.restaurantUpdate).toHaveBeenCalledWith({
      where: { id: "rest-1" },
      data: { salesTaxKind: "inc", salesTaxPct: 8 },
      select: { salesTaxKind: true, salesTaxPct: true },
    });
    expect(await res.json()).toEqual({
      settings: { salesTaxKind: "inc", salesTaxPct: 8 },
    });
  });

  it("el GET tampoco pide el módulo", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      settings: expect.objectContaining({ salesTaxKind: "none", salesTaxPct: 0 }),
      country: "CO",
    });
  });
});

describe("el guard de rol sigue vivo", () => {
  it.each(["mesero", "kitchen", "bar", "terminal", "diner"])(
    "rol %s ⇒ 401 y no toca la DB",
    async (role) => {
      m.auth.mockResolvedValue({ user: { role } });
      const res = await patch({ salesTaxKind: "inc", salesTaxPct: 8 });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(m.restaurantUpdate).not.toHaveBeenCalled();
    },
  );

  it("sin sesión ⇒ 401", async () => {
    m.auth.mockResolvedValue(null);
    expect((await patch({ salesTaxKind: "inc", salesTaxPct: 8 })).status).toBe(401);
    expect((await get()).status).toBe(401);
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });

  it("platform_admin pasa", async () => {
    m.auth.mockResolvedValue({ user: { role: "platform_admin" } });
    expect((await patch({ salesTaxKind: "iva", salesTaxPct: 19 })).status).toBe(200);
  });

  it("sin restaurante activo ⇒ 400", async () => {
    m.activeRestaurantId.mockResolvedValue(null);
    const res = await patch({ salesTaxKind: "inc", salesTaxPct: 8 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_restaurant" });
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });
});

describe("validación", () => {
  it.each([150, -1, 7.5, "8", null])("tarifa %s ⇒ 400 invalid", async (pct) => {
    const res = await patch({ salesTaxKind: "iva", salesTaxPct: pct });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });

  it("tipo de impuesto desconocido ⇒ 400", async () => {
    const res = await patch({ salesTaxKind: "ica", salesTaxPct: 8 });
    expect(res.status).toBe(400);
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });

  it("cuerpo que no es JSON ⇒ 400, no 500", async () => {
    const res = await patch("esto no es json");
    expect(res.status).toBe(400);
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });

  it('"none" fuerza la tarifa a 0 aunque manden otra', async () => {
    const res = await patch({ salesTaxKind: "none", salesTaxPct: 19 });
    expect(res.status).toBe(200);
    expect(m.restaurantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { salesTaxKind: "none", salesTaxPct: 0 } }),
    );
  });
});

describe("la ruta vieja", () => {
  it("/accounting/tax-config responde con los MISMOS handlers (sin gate)", () => {
    expect(legacy.GET).toBe(GET);
    expect(legacy.PATCH).toBe(PATCH);
  });
});
