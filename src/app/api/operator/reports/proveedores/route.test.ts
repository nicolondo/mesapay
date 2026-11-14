import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupplierReportRow } from "@/lib/erp/reports/supplierReport";

const m = vi.hoisted(() => ({ ctx: vi.fn(), rows: vi.fn(), tenant: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: m.ctx,
  isDenied: (c: unknown) => typeof c === "object" && c !== null && "error" in c,
}));
vi.mock("@/lib/erp/reports/supplierReportQueries", () => ({ loadSupplierReportRows: m.rows }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: m.tenant } } }));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "es",
}));
import { GET } from "./route";

const req = (qs = "") => new Request(`http://localhost/api/operator/reports/proveedores${qs}`);

function row(i: number, over: Partial<SupplierReportRow> = {}): SupplierReportRow {
  return {
    supplierId: `s${i}`,
    name: `Proveedor ${String(i).padStart(3, "0")}`,
    active: true,
    document: null,
    creditDays: i % 2 === 0 ? 30 : null,
    totalCents: i * 1_200,
    averageCents: i * 100,
    invoices: i,
    lastPurchase: null,
    payableCents: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.ctx.mockResolvedValue({ restaurantId: "restaurant-1", country: "CO", userId: "user-1" });
  m.rows.mockResolvedValue(Array.from({ length: 120 }, (_, i) => row(i + 1)));
  m.tenant.mockResolvedValue({ name: "Comercio", legalName: null, taxId: null });
});

describe("GET /api/operator/reports/proveedores", () => {
  it("sin permiso responde el error del guard (mesero / módulo apagado) sin leer datos", async () => {
    m.ctx.mockResolvedValue({ error: "unauthorized", status: 401 });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(m.rows).not.toHaveBeenCalled();
  });

  it("abre con Compras o con Contabilidad y lee SOLO el comercio de la sesión", async () => {
    await GET(req());
    expect(m.ctx).toHaveBeenCalledWith(["purchasing", "accounting"]);
    expect(m.rows.mock.calls[0]![0]).toBe("restaurant-1");
  });

  it("JSON: pagina en el servidor con totales de todo lo filtrado", async () => {
    const body = await (await GET(req("?pagina=3"))).json();
    expect(body).toMatchObject({ page: 3, pages: 3, total: 120, from: 101, to: 120 });
    expect(body.rows).toHaveLength(20);
    // Orden por defecto: promedio de mayor a menor.
    expect(body.rows[0].supplierId).toBe("s20");
    expect(body.totals.suppliers).toBe(120);
    expect(body.period.months).toBe(12);
  });

  it("formato desconocido → 400", async () => {
    expect((await GET(req("?format=pdf"))).status).toBe(400);
  });

  it("Excel: TODAS las filas filtradas (no solo la página), con nombre del período", async () => {
    const res = await GET(req("?format=xlsx&condicion=credito&pagina=2"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("spreadsheetml");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="proveedores-\d{4}-\d{2}-a-\d{4}-\d{2}\.xlsx"$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.getWorksheet("sheetData")!;
    // 60 con crédito + encabezado + total.
    expect(ws.rowCount).toBe(62);
    expect(ws.getRow(2).getCell(1).value).toBe("Proveedor 120");
  });

  it("CSV: mismas filas en el dialecto de los reportes", async () => {
    const res = await GET(req("?format=csv&q=Proveedor%2000"));
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const lines = (await res.text()).split("\r\n");
    // nota + encabezados + 9 proveedores (001–009) + total.
    expect(lines).toHaveLength(12);
    expect(lines[2]!.startsWith("Proveedor 009;")).toBe(true);
  });
});
