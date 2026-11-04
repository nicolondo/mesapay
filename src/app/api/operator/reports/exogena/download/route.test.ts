// GET /reports/exogena/download: XML ISO-8859-1 con nombre DIAN (200),
// 422 con incidencias bloqueantes, 404 para comercios fuera de Colombia,
// 400 con formato/año/tipo inválidos. `type=xlsx`: el Excel de revisión,
// que se descarga siempre (con incidencias bloqueantes y para el 2276).
// Las fuentes van mockeadas (sin DB).
import ExcelJS from "exceljs";
import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import es from "../../../../../../../messages/es.json";
import { buildExogenaReport, type ExogenaInputs } from "@/lib/erp/exogena/sources";

const state = vi.hoisted(() => ({
  country: "CO" as string | null,
  denied: null as null | { error: string; status: number },
  inputs: null as unknown,
  load: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => state.denied ?? { restaurantId: "r1", country: state.country, userId: "u1" },
  isDenied: (c: object) => "error" in c,
}));
vi.mock("@/lib/erp/exogena/queries", () => ({
  loadExogenaReport: state.load,
}));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: state.findUnique } } }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "es", messages: es as unknown as AbstractIntlMessages, namespace }),
  getLocale: async () => "es",
}));

import { GET } from "./route";

const empty: ExogenaInputs = {
  purchases: [], expenses: [], sales: [], receivables: [], payables: [], filings: [], payroll: [], shareholders: [], holdings: [],
};
const acme = { id: "s1", name: "ACME S.A.S.", taxId: "900123456", address: "" };

const get = (qs: string) => GET(new Request(`http://localhost/api/operator/reports/exogena/download?${qs}`));

async function workbook(res: Response): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await res.arrayBuffer()) as ExcelJS.Buffer);
  return wb;
}

beforeEach(() => {
  state.country = "CO";
  state.denied = null;
  state.load.mockReset();
  state.load.mockImplementation(async () => ({
    uvtPesos: 49799,
    report: buildExogenaReport((state.inputs as ExogenaInputs | null) ?? empty),
  }));
  state.findUnique.mockReset();
  state.findUnique.mockResolvedValue({ name: "Casa Teresita", legalName: "Casa Teresita S.A.S.", taxId: "901555333-2" });
});

describe("descarga del XML oficial", () => {
  it("200: XML en latin1, Content-Type ISO-8859-1 y nombre Dmuisca del formato/versión/año", async () => {
    state.inputs = {
      ...empty,
      purchases: [{ supplier: acme, netCents: 100_000_000, ivaCents: 19_000_000, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 }],
    };
    for (const qs of ["formato=1001&year=2025", "formato=1001&year=2025&type=xml"]) {
      const res = await get(qs);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/xml; charset=ISO-8859-1");
      expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Dmuisca_010100111202600000001.xml"');
      const bytes = new Uint8Array(await res.arrayBuffer());
      const xml = Buffer.from(bytes).toString("latin1");
      expect(xml).toContain('<?xml version="1.0" encoding="ISO-8859-1"?>');
      expect(xml).toContain("<Ano>2026</Ano>");
      expect(xml).toContain('<pagos cpt="5016" tdoc="31" nid="900123456"');
      expect(xml).toContain('pago="1000000"');
    }
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

  it("422 no_xml para el 2276; 400 con formato, año o tipo inválidos", async () => {
    state.inputs = empty;
    expect((await get("formato=1003&year=2025")).status).toBe(400);
    expect((await get("formato=1001&year=abcd")).status).toBe(400);
    expect((await get("formato=1001&year=1999")).status).toBe(400);
    expect((await get("formato=1001&year=2025&type=csv")).status).toBe(400);
    expect((await get("formato=1003&year=2025&type=xlsx")).status).toBe(400);
    expect(state.load).not.toHaveBeenCalled();
    const res = await get("formato=2276&year=2025");
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("no_xml");
  });

  it("404 not_applicable fuera de Colombia, sin consultar las fuentes", async () => {
    for (const c of ["MX", "BR", null]) {
      state.country = c;
      for (const type of ["xml", "xlsx"]) {
        const res = await get(`formato=1001&year=2025&type=${type}`);
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe("not_applicable");
      }
    }
    expect(state.load).not.toHaveBeenCalled();
  });

  it("sin permiso (401) no se descarga ni el XML ni el Excel, y no se consulta nada", async () => {
    state.denied = { error: "unauthorized", status: 401 };
    for (const type of ["xml", "xlsx"]) {
      const res = await get(`formato=1001&year=2025&type=${type}`);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("unauthorized");
    }
    expect(state.load).not.toHaveBeenCalled();
    expect(state.findUnique).not.toHaveBeenCalled();
  });
});

describe("descarga del Excel (type=xlsx)", () => {
  it("200: .xlsx con el nombre Dmuisca, los registros del XML y la información del informante", async () => {
    state.inputs = {
      ...empty,
      purchases: [{ supplier: acme, netCents: 100_000_000, ivaCents: 19_000_000, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 }],
    };
    const res = await get("formato=1001&year=2025&type=xlsx");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Dmuisca_010100111202600000001.xlsx"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const wb = await workbook(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Formato 1001", "Información"]);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(1).getCell(1).value).toBe("Concepto");
    expect(ws.getRow(1).getCell(13).value).toBe("Pago o abono en cuenta deducible");
    expect([ws.getRow(2).getCell(1).value, ws.getRow(2).getCell(3).value, ws.getRow(2).getCell(13).value]).toEqual([
      "5016",
      "900123456",
      1_000_000,
    ]);
    const info = wb.getWorksheet("Información")!;
    expect(info.getRow(1).values).toEqual([, "Informante", "Casa Teresita S.A.S."]);
    expect(info.getRow(2).values).toEqual([, "NIT del informante", "901555333-2"]);
    expect(state.load).toHaveBeenCalledWith("r1", 2025);
    expect(state.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r1" } }));
  });

  it("con incidencias bloqueantes el XML sigue en 422 pero el Excel sale con la hoja de incidencias", async () => {
    state.inputs = {
      ...empty,
      purchases: [
        { supplier: acme, netCents: 100_000_000, ivaCents: 0, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
        { supplier: { id: "s2", name: "Sin NIT Ltda", taxId: null, address: "" }, netCents: 5_000_000, ivaCents: 0, indedCents: 0, retefuenteCents: 0, reteIvaCents: 0 },
      ],
    };
    expect((await get("formato=1001&year=2025")).status).toBe(422);
    const res = await get("formato=1001&year=2025&type=xlsx");
    expect(res.status).toBe(200);
    const wb = await workbook(res);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Formato 1001", "Incidencias", "Información"]);
    const inc = wb.getWorksheet("Incidencias")!.getRow(2).values as unknown[];
    expect(inc.slice(1)).toEqual(["Bloquea", "Sin NIT Ltda", "Sin número de documento", 50_000, "3"]);
    // La fila del tercero sin documento va al final, marcada.
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(3).getCell(3).value).toBeNull();
    expect((ws.getRow(3).getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFDE2E1");
  });

  it("2276: sin XML pero con Excel (hoja de trabajo por empleado)", async () => {
    state.inputs = {
      ...empty,
      payroll: [{ employeeId: "e1", employeeName: "Ana Pérez", conceptKey: "salario", kind: "devengado", amountCents: 150_000_000 }],
    };
    expect((await get("formato=2276&year=2025")).status).toBe(422);
    const res = await get("formato=2276&year=2025&type=xlsx");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Dmuisca_010227604202600000001.xlsx"');
    const wb = await workbook(res);
    const ws = wb.getWorksheet("Formato 2276")!;
    expect(ws.getRow(2).getCell(3).value).toBe("Pérez");
    expect(ws.getRow(2).getCell(7).value).toBe(1_500_000);
    expect(wb.getWorksheet("Incidencias")!.getRow(2).getCell(3).value).toBe(
      "Empleado sin documento en MESAPAY: el 2276 no genera XML",
    );
  });
});
