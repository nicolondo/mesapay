import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BalanceInput } from "@/lib/erp/reports/balanceSheet";

/**
 * `GET /api/operator/reports/balance-sheet` — lo que hay que blindar:
 *   1. el gate corta antes de consultar;
 *   2. `corte` se valida (fecha real) y por defecto es hoy;
 *   3. la consulta va con el límite UTC EXCLUSIVO del día siguiente al corte;
 *   4. el JSON trae corte, período abierto, tres secciones, totales y cuadre;
 *   5. `format=csv` descarga con la nota del corte como primera fila,
 *      subtotales, totales de sección y «Total pasivo + patrimonio».
 *
 * La capa de consultas está mockeada: aquí se prueba la ruta, no Prisma.
 */
type Account = { code: string; name: string; type: string; nature: string; postable: boolean; active: boolean };

const h = vi.hoisted(() => {
  const state = {
    ctx: { restaurantId: "r1", country: "CO", userId: "u1" } as
      | { restaurantId: string; country: string; userId: string }
      | { error: string; status: number },
    balances: [] as BalanceInput[],
    accounts: [] as Account[],
    closings: [] as string[],
    calls: [] as { restaurantId: string; to: string }[],
  };
  return {
    state,
    getErpContext: vi.fn(async () => state.ctx),
    loadBalancesThrough: vi.fn(async (restaurantId: string, to: Date) => {
      state.calls.push({ restaurantId, to: to.toISOString() });
      return state.balances;
    }),
    loadReportAccounts: vi.fn(async () => state.accounts),
    loadClosingDates: vi.fn(async () => state.closings),
  };
});

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: h.getErpContext,
  isDenied: (ctx: unknown) => typeof ctx === "object" && ctx !== null && "error" in ctx,
}));
vi.mock("@/lib/erp/reports/queries", () => ({
  loadBalancesThrough: h.loadBalancesThrough,
  loadReportAccounts: h.loadReportAccounts,
  loadClosingDates: h.loadClosingDates,
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
  const req = new Request(`http://localhost/api/operator/reports/balance-sheet${query}`);
  return (GET as unknown as (r: Request) => Promise<Response>)(req);
}

const A = (code: string, name: string, type: string, postable = false): Account => ({
  code,
  name,
  type,
  nature: "debito",
  postable,
  active: true,
});

beforeEach(() => {
  h.state.ctx = { restaurantId: "r1", country: "CO", userId: "u1" };
  h.state.calls = [];
  h.state.closings = ["2025-12-31"];
  h.state.accounts = [
    A("11", "Disponible", "activo"),
    A("1105", "Caja", "activo"),
    A("110505", "Caja general", "activo", true),
    A("22", "Proveedores", "pasivo"),
    A("2205", "Nacionales", "pasivo"),
    A("220505", "Proveedores nacionales", "pasivo", true),
    A("31", "Capital social", "patrimonio"),
    A("3105", "Capital suscrito", "patrimonio"),
    A("310505", "Capital autorizado", "patrimonio", true),
    A("36", "Resultados", "patrimonio"),
    A("3605", "Utilidad del ejercicio", "patrimonio"),
    A("360505", "Utilidad del ejercicio", "patrimonio", true),
    A("413505", "Ventas", "ingreso", true),
    A("513505", "Servicios", "gasto", true),
  ];
  // Caja 12.000; proveedores 2.000; capital 7.000; utilidad cerrada 2.000;
  // período abierto: ventas 1.500 − gastos 500 = 1.000. Activo 12.000 =
  // 2.000 + (9.000 + 1.000).
  h.state.balances = [
    { accountCode: "110505", balanceCents: 12_000 },
    { accountCode: "220505", balanceCents: -2_000 },
    { accountCode: "310505", balanceCents: -7_000 },
    { accountCode: "360505", balanceCents: -2_000 },
    { accountCode: "413505", balanceCents: -1_500 },
    { accountCode: "513505", balanceCents: 500 },
  ];
});

describe("gate y validación", () => {
  it("responde el error del gate sin consultar", async () => {
    h.state.ctx = { error: "module_disabled", status: 403 };
    const res = await get("?corte=2026-03-31");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "module_disabled" });
    expect(h.loadBalancesThrough).not.toHaveBeenCalled();
  });

  it("400 invalid con un corte imposible o un formato raro", async () => {
    expect((await get("?corte=2026-02-31")).status).toBe(400);
    expect((await get("?corte=ayer")).status).toBe(400);
    expect((await get("?format=xlsx")).status).toBe(400);
    expect(h.loadBalancesThrough).not.toHaveBeenCalled();
  });
});

describe("JSON", () => {
  it("consulta hasta el día siguiente al corte (exclusivo) y devuelve secciones, totales y cuadre", async () => {
    const res = await get("?corte=2026-03-31");
    expect(res.status).toBe(200);
    expect(h.state.calls).toEqual([{ restaurantId: "r1", to: "2026-04-01T00:00:00.000Z" }]);
    const body = await res.json();
    expect(body.cutoff).toBe("2026-03-31");
    expect(body.openYearStart).toBe("2026-01-01");
    expect(body.sections.activo.rows.map((r: { code: string }) => r.code)).toEqual(["11", "1105", "110505"]);
    expect(body.sections.activo.totalCents).toBe(12_000);
    expect(body.sections.pasivo.totalCents).toBe(2_000);
    const patrimonio = body.sections.patrimonio.rows as { code: string; name: string; valueCents: number }[];
    expect(patrimonio.at(-1)).toMatchObject({
      code: "",
      name: "[bsUtilidad:01/01/2026]",
      valueCents: 1_000,
    });
    expect(body.sections.patrimonio.totalCents).toBe(10_000);
    expect(body.totals).toMatchObject({
      activoCents: 12_000,
      pasivoCents: 2_000,
      patrimonioCents: 9_000,
      utilidadCents: 1_000,
      totalPatrimonioCents: 10_000,
      totalPasivoPatrimonioCents: 12_000,
      differenceCents: 0,
    });
    expect(body.balanced).toBe(true);
  });

  it("sin corte usa hoy y el período abierto se acota al corte", async () => {
    h.state.closings = ["2025-12-31", "2099-12-31"];
    const res = await get("");
    const body = await res.json();
    const year = new Date().getUTCFullYear();
    expect(body.cutoff.slice(0, 4)).toBe(String(year));
    expect(body.openYearStart).toBe("2026-01-01");
  });

  it("marca el descuadre cuando activo ≠ pasivo + patrimonio", async () => {
    h.state.balances = [
      { accountCode: "110505", balanceCents: 12_000 },
      { accountCode: "220505", balanceCents: -2_000 },
    ];
    const body = await (await get("?corte=2026-03-31")).json();
    expect(body.balanced).toBe(false);
    expect(body.totals.differenceCents).toBe(10_000);
  });
});

describe("CSV", () => {
  it("descarga con la nota del corte primero, encabezados, subtotales y el total final", async () => {
    const res = await get("?corte=2026-03-31&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="estado-situacion-financiera-2026-03-31.csv"',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split("\r\n");
    expect(lines[0]).toMatch(/^\[bsCsvNote:/);
    expect(lines[1]).toBe("[csvSection];[csvCode];[colAccount];[colValue]");
    expect(lines[2]).toBe("[bsActivo];11;Disponible;120,00");
    expect(lines).toContain("[bsActivo];;[bsTotalActivo];120,00");
    expect(lines).toContain("[bsPasivo];220505;Proveedores nacionales;20,00");
    expect(lines).toContain("[bsPatrimonio];;[bsUtilidad:01/01/2026];10,00");
    expect(lines).toContain("[bsPatrimonio];;[bsTotalPatrimonio];100,00");
    expect(lines.at(-1)).toBe(";;[bsTotalPasivoPatrimonio];120,00");
  });
});
