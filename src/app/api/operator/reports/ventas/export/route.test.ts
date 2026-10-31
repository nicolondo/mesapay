import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: null as null | { user: { role: string; id: string } },
  load: vi.fn(),
  findUnique: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
// Permisos REALES de `getErpContext`: sólo se simulan la sesión y el comercio activo.
vi.mock("@/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => "restaurant-1" }));
vi.mock("@/lib/db", () => ({
  db: { restaurant: { findUnique: m.findUnique } },
}));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/salesAnalysis/load", () => ({ loadSalesAnalysis: m.load }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "es",
}));
import { GET } from "./route";

const req = (qs: string) => new Request(`http://localhost/api/operator/reports/ventas/export?${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  m.findUnique.mockImplementation(async (args: { select: Record<string, boolean> }) =>
    args.select.enabledModules && !args.select.name
      ? { enabledModules: [], country: "CO" }
      : { name: "Son y Melona", businessDayCutoffHour: 5, salesTaxKind: "inc", salesTaxPct: 8, serviceMode: "table", enabledModules: [] },
  );
});

describe("exportación del análisis de ventas — permisos", () => {
  it.each(["mesero", "kitchen", "bar", "terminal", "customer"])("%s no exporta (401) y no se consulta nada", async (role) => {
    m.session = { user: { role, id: "u1" } };
    const res = await GET(req("formato=csv"));
    expect(res.status).toBe(401);
    expect(m.load).not.toHaveBeenCalled();
  });

  it("sin sesión tampoco", async () => {
    m.session = null;
    expect((await GET(req("formato=xlsx"))).status).toBe(401);
  });

  it("formato inválido = 400", async () => {
    m.session = { user: { role: "operator", id: "u1" } };
    expect((await GET(req("formato=pdf"))).status).toBe(400);
    expect(m.load).not.toHaveBeenCalled();
  });

  it("la administración exporta con los filtros de la URL, acotado a su comercio", async () => {
    m.session = { user: { role: "group_admin", id: "u1" } };
    m.load.mockResolvedValue({
      filters: { dimOrder: [], dims: {} }, range: { from: "2026-10-01", to: "2026-10-31" }, compareRange: null,
      granularity: "dia", cutoffHour: 5, kpis: {}, compareKpis: null, compare: null,
      current: { trend: [], products: [], categories: [], waiters: [], methods: [], channels: [] },
      modifiers: [], tables: [], heat: [], orders: null, engineering: null,
      options: { waiters: [], categories: [], products: [], tables: [] },
    });
    const res = await GET(req("formato=csv&periodo=mes&canal=llevar"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("ventas-2026-10-01-a-2026-10-31.csv");
    const input = m.load.mock.calls[0]![1];
    expect(input.restaurantId).toBe("restaurant-1");
    expect(input.filters).toMatchObject({ period: "mes", dims: { canal: "llevar" } });
    expect(input.tax).toEqual({ kind: "inc", pct: 8 });
  });
});
