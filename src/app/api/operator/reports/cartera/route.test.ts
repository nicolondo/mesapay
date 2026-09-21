import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CarteraDoc } from "@/lib/erp/reports/cartera";

const m = vi.hoisted(() => ({ ctx: vi.fn(), payables: vi.fn(), receivables: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: m.ctx,
  isDenied: (c: unknown) => typeof c === "object" && c !== null && "error" in c,
}));
vi.mock("@/lib/erp/reports/carteraQueries", () => ({
  loadPayablesDocs: m.payables,
  loadReceivableDocs: m.receivables,
}));
// Las claves salen tal cual (con la variable, si la hay): el test verifica
// estructura, no textos.
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, vars?: Record<string, unknown>) =>
    vars && "date" in vars ? `${key}:${String(vars.date)}` : key,
}));
import { GET } from "./route";

const HASTA = "2026-09-21";

function doc(over: Partial<CarteraDoc> & { id: string }): CarteraDoc {
  return {
    source: "purchase_order",
    partnerId: "prov-a",
    partnerName: "Proveedor A",
    partnerTaxId: "900111222",
    number: "0001",
    date: "2026-09-01",
    dueDate: "2026-09-01",
    totalCents: 100_000,
    outstandingCents: 100_000,
    ...over,
  };
}

const req = (qs = "") => new Request(`http://localhost/api/operator/reports/cartera${qs}`);

beforeEach(() => {
  vi.resetAllMocks();
  m.ctx.mockResolvedValue({ restaurantId: "restaurant-1", country: "CO", userId: "user-1" });
  m.payables.mockResolvedValue([
    doc({ id: "a1", dueDate: "2026-08-01", outstandingCents: 40_000 }),
    doc({ id: "a2", dueDate: "2026-09-30", outstandingCents: 10_000 }),
    doc({
      id: "g1",
      source: "expense",
      partnerId: "sin-proveedor",
      partnerName: "",
      partnerTaxId: null,
      dueDate: "2026-09-21",
      outstandingCents: 5_000,
    }),
  ]);
  m.receivables.mockResolvedValue({
    enabled: true,
    docs: [
      doc({
        id: "c1",
        source: "voucher_statement",
        partnerId: "cli-1",
        partnerName: "Empresa Cliente",
        partnerTaxId: "800222333-4",
        dueDate: "2026-09-10",
        outstandingCents: 250_000,
      }),
    ],
  });
});

describe("GET /api/operator/reports/cartera (JSON)", () => {
  it("devuelve los dos lados agrupados por tercero a la fecha de corte", async () => {
    const res = await GET(req(`?hasta=${HASTA}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asOf).toBe(HASTA);
    expect(m.payables).toHaveBeenCalledWith("restaurant-1", HASTA);
    expect(m.receivables).toHaveBeenCalledWith("restaurant-1", HASTA);
    expect(body.payables.totals).toEqual({ outstandingCents: 55_000, partners: 2, docs: 3 });
    expect(body.payables.partners.map((p: { partnerId: string }) => p.partnerId)).toEqual([
      "prov-a",
      "sin-proveedor",
    ]);
    expect(body.payables.partners[0]).toMatchObject({
      docs: 2,
      oldestDue: "2026-08-01",
      worstBucket: "31-60",
      outstandingCents: 50_000,
    });
    expect(body.receivables).toMatchObject({
      enabled: true,
      totals: { outstandingCents: 250_000, partners: 1, docs: 1 },
    });
    expect(body.receivables.partners[0].worstBucket).toBe("1-30");
  });

  it("sin `hasta` corta a hoy y propaga `enabled: false` cuando no hay bonos", async () => {
    m.receivables.mockResolvedValue({ enabled: false, docs: [] });
    const body = await (await GET(req())).json();
    expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.receivables).toEqual({
      enabled: false,
      partners: [],
      totals: { outstandingCents: 0, partners: 0, docs: 0 },
    });
  });

  it("rechaza fechas y vistas inválidas sin consultar", async () => {
    expect((await GET(req("?hasta=2026-02-31"))).status).toBe(400);
    expect((await GET(req("?vista=otra"))).status).toBe(400);
    expect(m.payables).not.toHaveBeenCalled();
  });

  it("propaga el rechazo del gate (401 / 403 módulo apagado)", async () => {
    m.ctx.mockResolvedValue({ error: "module_disabled", status: 403 });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "module_disabled" });
    expect(m.payables).not.toHaveBeenCalled();
  });
});

describe("GET /api/operator/reports/cartera (CSV)", () => {
  it("proveedores por defecto: nota, encabezados, tercero sintético traducido y saldo con coma", async () => {
    const res = await GET(req(`?hasta=${HASTA}&format=csv`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(`cartera-proveedores-${HASTA}.csv`);
    // `text()` descarta el BOM al decodificar (Fetch spec): se mira en bytes.
    const buf = Buffer.from(await res.arrayBuffer());
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = buf.toString("utf8").slice(1).split("\r\n");
    expect(lines[0]).toBe(`csvNote:${HASTA}`);
    expect(lines[1]).toBe("colPartner;colTaxId;colDocs;colOldestDue;colAging;colBalance");
    expect(lines[2]).toBe("Proveedor A;900111222;2;2026-08-01;bucket31_60;500,00");
    expect(lines[3]).toBe("noSupplier;;1;2026-09-21;bucketCurrent;50,00");
    expect(lines).toHaveLength(4);
  });

  it("`vista=cxc` exporta el archivo de clientes", async () => {
    const res = await GET(req(`?hasta=${HASTA}&vista=cxc&format=csv`));
    expect(res.headers.get("content-disposition")).toContain(`cartera-clientes-${HASTA}.csv`);
    const lines = (await res.text()).split("\r\n");
    expect(lines[2]).toBe("Empresa Cliente;800222333-4;1;2026-09-10;bucket1_30;2500,00");
  });
});
