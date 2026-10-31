// Importar el plan de cuentas del contador: acepta la clase 7 (como el alta
// manual), no reactiva cuentas que el comercio desactivó y no cambia la
// naturaleza de una cuenta que ya tiene movimientos.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  linesGroupBy: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/ledger", () => ({ ensureChartOfAccounts: vi.fn(), loadChartOfAccounts: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    ledgerAccount: { findMany: m.findMany, createMany: m.createMany, update: m.update },
    journalLine: { groupBy: m.linesGroupBy },
  },
}));

import { POST } from "./route";
import { parseChartCsv } from "@/lib/erp/chartImport";

const post = (csv: string) =>
  (POST as unknown as (r: Request) => Promise<Response>)(
    new Request("http://x/api/operator/accounting/chart", { method: "POST", body: JSON.stringify({ csv }) }),
  );

beforeEach(() => {
  vi.resetAllMocks();
  m.createMany.mockResolvedValue({ count: 0 });
  m.update.mockResolvedValue({});
  m.linesGroupBy.mockResolvedValue([]);
});

describe("parseChartCsv — clase 7", () => {
  it("la acepta como costo, igual que el alta manual", () => {
    const { rows, issues } = parseChartCsv("730505;Costos de producción;D;true");
    expect(issues).toEqual([]);
    expect(rows.find((r) => r.code === "730505")).toMatchObject({ type: "costo", nature: "debito" });
  });
});

describe("POST /api/operator/accounting/chart (importar)", () => {
  it("actualiza el nombre de una cuenta inactiva sin reactivarla y avisa", async () => {
    m.findMany.mockResolvedValue([
      { code: "110505", name: "Caja", nature: "debito", postable: true, active: false },
      { code: "1105", name: "Caja", nature: "debito", postable: false, active: true },
      { code: "11", name: "Disponible", nature: "debito", postable: false, active: true },
      { code: "1", name: "Activo", nature: "debito", postable: false, active: true },
    ]);
    const res = await post("110505;Caja general;D;true");
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, updated: 1, inactiveKept: 1, natureKept: 0 });
    expect(m.update).toHaveBeenCalledWith({
      where: { restaurantId_code: { restaurantId: "r1", code: "110505" } },
      data: { name: "Caja general", nature: "debito", postable: true },
    });
  });

  it("no cambia la naturaleza de una cuenta con movimientos", async () => {
    m.findMany.mockResolvedValue([
      { code: "130505", name: "Clientes", nature: "debito", postable: true, active: true },
      { code: "1305", name: "Clientes", nature: "debito", postable: false, active: true },
      { code: "13", name: "Deudores", nature: "debito", postable: false, active: true },
      { code: "1", name: "Activo", nature: "debito", postable: false, active: true },
    ]);
    m.linesGroupBy.mockResolvedValue([{ accountCode: "130505" }]);
    const j = await (await post("130505;Clientes nacionales;C;true")).json();
    expect(j).toMatchObject({ natureKept: 1, updated: 1 });
    expect(m.update.mock.calls[0]![0].data).toEqual({ name: "Clientes nacionales", nature: "debito", postable: true });
    expect(m.linesGroupBy.mock.calls[0]![0].where).toEqual({
      accountCode: { in: ["130505"] },
      entry: { restaurantId: "r1" },
    });
  });
});
