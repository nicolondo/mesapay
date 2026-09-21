import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultMovement } from "@/lib/erp/reports/incomeStatement";

/**
 * `GET /api/operator/reports/income-statement` — lo que hay que blindar:
 *   1. el gate corta antes de consultar;
 *   2. el período se valida (fechas reales, rango al derecho) y sigue la
 *      prioridad de `resolveReportPeriod` (`desde/hasta` → `anio` → hoy);
 *   3. la consulta va con límites UTC (`hasta` exclusivo);
 *   4. el JSON trae la cascada con etiquetas traducidas, el resumen y los
 *      meses; la cascada depende del país del comercio;
 *   5. `format=csv` descarga con la nota del período, bandas y total.
 *
 * La exclusión de los asientos de cierre la hace SQL en
 * `queries.loadResultMovements` (mockeada aquí).
 */
type Account = { code: string; name: string; type: string; nature: string; postable: boolean; active: boolean };

const h = vi.hoisted(() => {
  const state = {
    ctx: { restaurantId: "r1", country: "CO", userId: "u1" } as
      | { restaurantId: string; country: string | null; userId: string }
      | { error: string; status: number },
    movements: [] as ResultMovement[],
    accounts: [] as Account[],
    calls: [] as { restaurantId: string; from: string; to: string }[],
  };
  return {
    state,
    getErpContext: vi.fn(async () => state.ctx),
    loadResultMovements: vi.fn(async (restaurantId: string, from: Date, to: Date) => {
      state.calls.push({ restaurantId, from: from.toISOString(), to: to.toISOString() });
      return state.movements;
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
  loadResultMovements: h.loadResultMovements,
  loadReportAccounts: h.loadReportAccounts,
}));
vi.mock("@/lib/billing/countries", () => ({
  getCurrencyForCountry: vi.fn(async (country: string | null) => (country === "MX" ? "MXN" : "COP")),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => {
    const t = (key: string, params?: Record<string, string | number>) =>
      params ? `[${key}:${Object.values(params).join(",")}]` : `[${key}]`;
    t.has = () => true;
    return t;
  }),
  getLocale: vi.fn(async () => "es"),
}));

import { GET } from "./route";

function get(query: string): Promise<Response> {
  const req = new Request(`http://localhost/api/operator/reports/income-statement${query}`);
  return (GET as unknown as (r: Request) => Promise<Response>)(req);
}

const A = (code: string, name: string, type: string): Account => ({
  code,
  name,
  type,
  nature: "debito",
  postable: code.length >= 6,
  active: true,
});

beforeEach(() => {
  h.state.ctx = { restaurantId: "r1", country: "CO", userId: "u1" };
  h.state.calls = [];
  h.state.accounts = [
    A("41", "Operacionales", "ingreso"),
    A("413505", "Ventas", "ingreso"),
    A("613505", "Costo", "costo"),
    A("5105", "Gastos de personal", "gasto"),
    A("510506", "Sueldos", "gasto"),
    A("5205", "Personal ventas", "gasto"),
    A("520506", "Sueldos ventas", "gasto"),
    A("540505", "Impuesto de renta", "gasto"),
  ];
  h.state.movements = [
    { accountCode: "413505", month: "2026-01", movementCents: -100_000 },
    { accountCode: "413505", month: "2026-02", movementCents: -50_000 },
    { accountCode: "613505", month: "2026-01", movementCents: 40_000 },
    { accountCode: "510506", month: "2026-01", movementCents: 10_000 },
    { accountCode: "520506", month: "2026-02", movementCents: 5_000 },
    { accountCode: "540505", month: "2026-02", movementCents: 3_000 },
  ];
});

describe("gate y validación", () => {
  it("responde el error del gate sin consultar", async () => {
    h.state.ctx = { error: "unauthorized", status: 401 };
    const res = await get("?anio=2026");
    expect(res.status).toBe(401);
    expect(h.loadResultMovements).not.toHaveBeenCalled();
  });

  it("400 invalid con fecha imposible, rango al revés o formato raro", async () => {
    expect((await get("?desde=2026-02-31")).status).toBe(400);
    expect((await get("?desde=2026-03-01&hasta=2026-02-01")).status).toBe(400);
    expect((await get("?format=pdf")).status).toBe(400);
    expect(h.loadResultMovements).not.toHaveBeenCalled();
  });
});

describe("JSON", () => {
  it("con `anio` consulta el ejercicio completo (hasta exclusivo) y devuelve la cascada CO traducida", async () => {
    const res = await get("?anio=2026");
    expect(res.status).toBe(200);
    expect(h.state.calls).toEqual([
      { restaurantId: "r1", from: "2026-01-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" },
    ]);
    const body = await res.json();
    expect(body.period).toEqual({ desde: "2026-01-01", hasta: "2026-12-31", year: 2026 });
    expect(body.country).toBe("CO");
    expect(body.classification).toBe("co");
    expect(body.summary).toEqual({
      incomeCents: 150_000,
      costCents: 40_000,
      expensesCents: 15_000,
      incomeTaxCents: 3_000,
      resultCents: 92_000,
      oriCents: 0,
      integralCents: 92_000,
    });
    const cascade = body.cascade as { key: string; label: string; valueCents?: number; code?: string }[];
    expect(cascade.map((r) => r.key)).toEqual([
      "ing", "costo-inv", "nat-05", "antes-imp", "imp", "neto", "ori-head", "ori-nota", "integral",
    ]);
    expect(cascade[0]).toMatchObject({ label: "[isIncomeOrdinary]", code: "41", valueCents: 100_000 + 50_000 });
    expect(cascade[2]).toMatchObject({ label: "Gastos de personal", code: "x05", valueCents: -15_000 });
    expect(cascade[3]).toMatchObject({ label: "[isBeforeTax]", valueCents: 95_000 });
    expect(cascade.at(-1)).toMatchObject({ label: "[isIntegral]", valueCents: 92_000 });
    expect(body.months).toHaveLength(12);
    expect(body.months[0]).toMatchObject({ key: "2026-01", incomeCents: 100_000, resultCents: 50_000, partial: false });
    expect(body.months[1]).toMatchObject({ key: "2026-02", incomeCents: 50_000, resultCents: 42_000 });
    expect(body.issues).toEqual([]);
    expect(body.hasMovements).toBe(true);
  });

  it("`desde/hasta` explícitos mandan sobre `anio` y marcan los meses parciales", async () => {
    const res = await get("?anio=2025&desde=2026-01-15&hasta=2026-02-10");
    const body = await res.json();
    expect(body.period).toEqual({ desde: "2026-01-15", hasta: "2026-02-10", year: null });
    expect(body.months.map((m: { key: string; partial: boolean }) => [m.key, m.partial])).toEqual([
      ["2026-01", true],
      ["2026-02", true],
    ]);
  });

  it("fuera de Colombia la cascada es genérica y el 54 es un gasto más", async () => {
    h.state.ctx = { restaurantId: "r1", country: "MX", userId: "u1" };
    const body = await (await get("?anio=2026")).json();
    expect(body.classification).toBe("generic");
    expect(body.cascade.map((r: { key: string }) => r.key)).toEqual(["ing", "costo-inv", "otros-gastos", "neto"]);
    expect(body.summary.expensesCents).toBe(18_000);
    expect(body.summary.incomeTaxCents).toBe(0);
    expect(body.issues).toEqual(["[isIssueGeneric]"]);
  });
});

describe("CSV", () => {
  it("descarga con la nota del período y la moneda, encabezados traducidos, bandas y total", async () => {
    const res = await get("?anio=2026&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="estado-resultado-2026-01-01-a-2026-12-31.csv"',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split("\r\n");
    expect(lines[0]).toMatch(/^\[isYearLabel:2026\] · \[periodLabel:.*\] · COP$/);
    expect(lines[1]).toBe("[csvSection];[csvCode];[csvConcept];[colValueCurrency:COP]");
    expect(lines[2]).toBe(";41;[isIncomeOrdinary];1500,00");
    expect(lines).toContain(";x05;Gastos de personal;-150,00");
    expect(lines).toContain(";;[isBeforeTax];950,00");
    expect(lines.at(-1)).toBe("[isOriHead];;[isIntegral];920,00");
    // La nota «sin ORI» no lleva cifra y no sale.
    expect(lines.some((l) => l.includes("[isOriNone]"))).toBe(false);
  });
});
