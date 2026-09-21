// GET /reports/exogena/download: XML ISO-8859-1 con nombre DIAN (200),
// 422 con incidencias bloqueantes, 404 para comercios fuera de Colombia,
// 400 con formato/año inválidos. Las fuentes van mockeadas (sin DB).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildExogenaReport, type ExogenaInputs } from "@/lib/erp/exogena/sources";

const state = vi.hoisted(() => ({
  country: "CO" as string | null,
  inputs: null as unknown,
  load: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1", country: state.country, userId: "u1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/exogena/queries", () => ({
  loadExogenaReport: state.load,
}));

import { GET } from "./route";

const empty: ExogenaInputs = {
  purchases: [], expenses: [], sales: [], receivables: [], payables: [], filings: [], payroll: [], shareholders: [], holdings: [],
};
const acme = { id: "s1", name: "ACME S.A.S.", taxId: "900123456", address: "" };

const get = (qs: string) => GET(new Request(`http://localhost/api/operator/reports/exogena/download?${qs}`));

beforeEach(() => {
  state.country = "CO";
  state.load.mockReset();
  state.load.mockImplementation(async () => ({
    uvtPesos: 49799,
    report: buildExogenaReport((state.inputs as ExogenaInputs | null) ?? empty),
  }));
});

describe("descarga del XML oficial", () => {
  it("200: XML en latin1, Content-Type ISO-8859-1 y nombre Dmuisca del formato/versión/año", async () => {
    state.inputs = {
      ...empty,
      purchases: [{ supplier: acme, netCents: 100_000_000, ivaCents: 19_000_000, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 }],
    };
    const res = await get("formato=1001&year=2025");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=ISO-8859-1");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Dmuisca_010100111202600000001.xml"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const xml = Buffer.from(bytes).toString("latin1");
    expect(xml).toContain('<?xml version="1.0" encoding="ISO-8859-1"?>');
    expect(xml).toContain("<Ano>2026</Ano>");
    expect(xml).toContain('<pagos cpt="5016" tdoc="31" nid="900123456"');
    expect(xml).toContain('pago="1000000"');
    expect(state.load).toHaveBeenCalledWith("r1", 2025);
  });

  it("422 issues_pending con la lista cuando el formato tiene incidencias bloqueantes", async () => {
    state.inputs = {
      ...empty,
      purchases: [{ supplier: { ...acme, taxId: null }, netCents: 1, ivaCents: 0, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 }],
    };
    const res = await get("formato=1001&year=2025");
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("issues_pending");
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({ format: "1001", code: "missing_doc", name: "ACME S.A.S." });
    // La incidencia es del 1001: el 1007 se descarga igual.
    expect((await get("formato=1007&year=2025")).status).toBe(200);
  });

  it("422 no_xml para el 2276; 400 con formato o año inválidos", async () => {
    state.inputs = empty;
    expect((await get("formato=2276&year=2025")).status).toBe(422);
    expect((await get("formato=1003&year=2025")).status).toBe(400);
    expect((await get("formato=1001&year=abcd")).status).toBe(400);
    expect((await get("formato=1001&year=1999")).status).toBe(400);
  });

  it("404 not_applicable fuera de Colombia, sin consultar las fuentes", async () => {
    for (const c of ["MX", "BR", null]) {
      state.country = c;
      const res = await get("formato=1001&year=2025");
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("not_applicable");
    }
    expect(state.load).not.toHaveBeenCalled();
  });
});
