import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrialBalanceDbRow } from "@/lib/erp/reports/trialBalance";

/**
 * `GET /api/operator/reports/trial-balance` — lo que hay que blindar:
 *   1. el gate (`getErpContext`) corta antes de consultar;
 *   2. la query se valida (fechas reales, rango al derecho, nivel 1/2/4/6);
 *   3. el JSON trae la jerarquía, los totales y el cuadre;
 *   4. `format=csv` descarga con BOM, `;`, coma decimal y fila TOTAL, y con
 *      filtro de cuentas la nota va como primera fila.
 *
 * La capa de consultas está mockeada: aquí se prueba la ruta, no Prisma.
 */
const h = vi.hoisted(() => {
  const state = {
    ctx: { restaurantId: "r1", country: "CO", userId: "u1" } as
      | { restaurantId: string; country: string; userId: string }
      | { error: string; status: number },
    rows: [] as TrialBalanceDbRow[],
    accounts: [] as { code: string; name: string; type: string; nature: string; postable: boolean; active: boolean }[],
    calls: [] as { restaurantId: string; from: string; to: string }[],
  };
  return {
    state,
    getErpContext: vi.fn(async () => state.ctx),
    loadTrialBalanceRows: vi.fn(async (restaurantId: string, from: Date, to: Date) => {
      state.calls.push({ restaurantId, from: from.toISOString(), to: to.toISOString() });
      return state.rows;
    }),
    loadReportAccounts: vi.fn(async () => state.accounts),
  };
});

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: h.getErpContext,
  isDenied: (ctx: unknown) => typeof ctx === "object" && ctx !== null && "error" in ctx,
}));
vi.mock("@/lib/erp/reports/queries", () => ({
  loadTrialBalanceRows: h.loadTrialBalanceRows,
  loadReportAccounts: h.loadReportAccounts,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => {
    const t = (key: string) => `[${key}]`;
    t.has = () => true;
    return t;
  }),
}));

import { GET } from "./route";

function get(query: string): Promise<Response> {
  const req = new Request(`http://localhost/api/operator/reports/trial-balance${query}`);
  return (GET as unknown as (r: Request) => Promise<Response>)(req);
}

beforeEach(() => {
  h.state.ctx = { restaurantId: "r1", country: "CO", userId: "u1" };
  h.state.calls = [];
  h.state.accounts = [
    { code: "1", name: "Activo", type: "activo", nature: "debito", postable: false, active: true },
    { code: "11", name: "Efectivo", type: "activo", nature: "debito", postable: false, active: true },
    { code: "1105", name: "Caja", type: "activo", nature: "debito", postable: false, active: true },
    { code: "110505", name: "Caja general", type: "activo", nature: "debito", postable: true, active: true },
    { code: "4", name: "Ingresos", type: "ingreso", nature: "credito", postable: false, active: true },
    { code: "41", name: "Operacionales", type: "ingreso", nature: "credito", postable: false, active: true },
    { code: "4135", name: "Comercio", type: "ingreso", nature: "credito", postable: false, active: true },
    { code: "413505", name: "Ventas", type: "ingreso", nature: "credito", postable: true, active: true },
  ];
  h.state.rows = [
    { accountCode: "110505", initialCents: 1000, debitCents: 500, creditCents: 0, finalCents: 1500 },
    { accountCode: "413505", initialCents: -1000, debitCents: 0, creditCents: 500, finalCents: -1500 },
  ];
});

describe("gate y validación", () => {
  it("responde el error del gate sin consultar", async () => {
    h.state.ctx = { error: "module_disabled", status: 403 };
    const res = await get("?desde=2026-01-01&hasta=2026-01-31");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "module_disabled" });
    expect(h.loadTrialBalanceRows).not.toHaveBeenCalled();
  });

  it("400 invalid con fecha imposible, rango al revés o nivel raro", async () => {
    expect((await get("?desde=2026-02-31")).status).toBe(400);
    expect((await get("?desde=2026-03-01&hasta=2026-02-01")).status).toBe(400);
    expect((await get("?nivel=3")).status).toBe(400);
    expect((await get("?cta1=abc")).status).toBe(400);
    expect((await get("?format=xlsx")).status).toBe(400);
    expect(h.loadTrialBalanceRows).not.toHaveBeenCalled();
  });
});

describe("JSON", () => {
  it("consulta con límites UTC (hasta exclusivo) y devuelve jerarquía, totales y cuadre", async () => {
    const res = await get("?desde=2026-08-01&hasta=2026-08-31&nivel=6");
    expect(res.status).toBe(200);
    expect(h.state.calls).toEqual([
      { restaurantId: "r1", from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
    ]);
    const body = await res.json();
    expect(body.period).toEqual({ desde: "2026-08-01", hasta: "2026-08-31" });
    expect(body.level).toBe(6);
    expect(body.rows.map((r: { code: string; depth: number }) => `${r.depth}:${r.code}`)).toEqual([
      "0:1", "1:11", "2:1105", "3:110505", "0:4", "1:41", "2:4135", "3:413505",
    ]);
    expect(body.rows[0]).toMatchObject({ name: "Activo", initialCents: 1000, debitCents: 500, finalCents: 1500 });
    expect(body.totals).toEqual({ initialCents: 0, debitCents: 500, creditCents: 500, finalCents: 0 });
    expect(body.balanced).toBe(true);
    expect(body.filtered).toBe(false);
  });

  it("sin fechas usa 1 de enero → hoy; el nivel por defecto es 6", async () => {
    const res = await get("");
    const body = await res.json();
    const year = new Date().getUTCFullYear();
    expect(body.period.desde).toBe(`${year}-01-01`);
    expect(body.level).toBe(6);
  });

  it("filtro de cuentas: filas del prefijo, filtered=true, cuadre de todo el libro", async () => {
    const res = await get("?desde=2026-08-01&hasta=2026-08-31&cta1=11&cta2=11&nivel=4");
    const body = await res.json();
    expect(body.rows.map((r: { code: string }) => r.code)).toEqual(["1", "11", "1105"]);
    expect(body.totals.debitCents).toBe(500);
    expect(body.totals.creditCents).toBe(0);
    expect(body.filtered).toBe(true);
    expect(body.balanced).toBe(true);
  });
});

describe("CSV", () => {
  it("descarga con BOM, ;, coma decimal, encabezados traducidos y fila TOTAL", async () => {
    const res = await get("?desde=2026-08-01&hasta=2026-08-31&nivel=2&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="balance-prueba-2026-08-01-a-2026-08-31.csv"',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split("\r\n");
    expect(lines[0]).toBe("[csvCode];[colAccount];[colInitial];[colDebits];[colCredits];[colFinal]");
    expect(lines[1]).toBe("1;Activo;10,00;5,00;0,00;15,00");
    expect(lines[2]).toBe("11;Efectivo;10,00;5,00;0,00;15,00");
    expect(lines.at(-1)).toBe(";[csvTotal];0,00;5,00;5,00;0,00");
  });

  it("con filtro, la nota «totales del filtro» va como primera fila", async () => {
    const res = await get("?desde=2026-08-01&hasta=2026-08-31&cta1=4&format=csv");
    const lines = (await res.text()).split("\r\n");
    expect(lines[0]).toBe("[filteredTotals]");
    expect(lines[1]).toContain("[csvCode]");
  });
});
