import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const m = vi.hoisted(() => ({
  session: null as null | { user: { role: string; id: string } },
  load: vi.fn(),
}));
vi.mock("server-only", () => ({}));
// Permisos REALES de `getErpContext`: sólo se simulan la sesión y el comercio activo.
vi.mock("@/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => "restaurant-1" }));
vi.mock("@/lib/db", () => ({
  db: { restaurant: { findUnique: async () => ({ enabledModules: [], country: "CO" }) } },
}));
vi.mock("@/lib/salesAnalysis/load", () => ({ loadSalesAnalysis: m.load }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "es",
}));
import SalesAnalysisPage from "./page";

beforeEach(() => vi.clearAllMocks());

describe("Análisis de ventas — sólo administración del comercio", () => {
  it.each(["mesero", "kitchen", "bar", "terminal", "customer"])("%s no entra y no se consulta ninguna venta", async (role) => {
    m.session = { user: { role, id: "u1" } };
    const html = renderToStaticMarkup(await SalesAnalysisPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("noAccess");
    expect(m.load).not.toHaveBeenCalled();
  });

  it("sin sesión tampoco", async () => {
    m.session = null;
    const html = renderToStaticMarkup(await SalesAnalysisPage({ searchParams: Promise.resolve({ periodo: "mes" }) }));
    expect(html).toContain("noAccess");
    expect(m.load).not.toHaveBeenCalled();
  });
});
