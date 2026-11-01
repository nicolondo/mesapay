// Conciliación bancaria: se asienta contra la cuenta del banco elegida (o la
// imputable de 111005), la contrapartida tiene que ser imputable y activa, y
// repegar el extracto no duplica.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  lineFindMany: vi.fn(),
  lineFindFirst: vi.fn(),
  createMany: vi.fn(),
  entryCreate: vi.fn(),
  lineUpdate: vi.fn(),
  index: new Map<string, { id: string; postable: boolean; active: boolean }>(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (h: unknown) => h }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: async () => ({ restaurantId: "r1" }),
  isDenied: () => false,
}));
vi.mock("@/lib/erp/cierre", () => ({
  getAccountingConfig: async () => ({ closedThrough: "2026-08" }),
  isMonthClosed: (c: string | null, month: string) => c != null && month <= c,
}));
vi.mock("@/lib/erp/ledger", () => ({ loadAccountIndex: async () => m.index }));
vi.mock("@/lib/db", () => {
  const tx = {
    journalEntry: { create: m.entryCreate },
    bankStatementLine: { update: m.lineUpdate },
  };
  return {
    db: {
      bankStatementLine: { findMany: m.lineFindMany, findFirst: m.lineFindFirst, createMany: m.createMany },
      bankRecRule: { findMany: async () => [] },
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});

import { GET, PATCH, POST } from "./route";

const req = (method: string, body?: unknown) =>
  new Request("http://x/api/operator/accounting/bank", { method, body: body ? JSON.stringify(body) : undefined });
type H = (r: Request) => Promise<Response>;

beforeEach(() => {
  vi.resetAllMocks();
  m.index = new Map([
    ["1110", { id: "a1110", postable: false, active: true }],
    ["111005", { id: "a111005", postable: false, active: true }],
    ["11100501", { id: "aBanco1", postable: true, active: true }],
    ["11100502", { id: "aBanco2", postable: true, active: true }],
    ["5305", { id: "a5305", postable: false, active: true }],
    ["530505", { id: "a530505", postable: true, active: true }],
    ["519595", { id: "a519595", postable: true, active: false }],
  ]);
  m.entryCreate.mockResolvedValue({ id: "e1" });
  m.lineUpdate.mockResolvedValue({});
  m.createMany.mockResolvedValue({ count: 0 });
  m.lineFindFirst.mockResolvedValue({ id: "l1", date: new Date("2026-10-05T00:00:00Z"), description: "COMISION", amountCents: -15_000 });
});

describe("GET", () => {
  it("propone como banco la auxiliar convencional de 111005", async () => {
    m.lineFindMany.mockResolvedValue([]);
    const j = await (await (GET as unknown as H)(req("GET"))).json();
    expect(j.defaultBankAccountCode).toBe("11100501");
  });
});

describe("PATCH journalize", () => {
  it("asienta contra la cuenta del banco elegida, no contra 111005", async () => {
    const res = await (PATCH as unknown as H)(
      req("PATCH", { action: "journalize", lineId: "l1", accountCode: "530505", bankAccountCode: "11100502" }),
    );
    expect(res.status).toBe(200);
    const lines = m.entryCreate.mock.calls[0]![0].data.lines.create;
    expect(lines).toEqual([
      expect.objectContaining({ accountCode: "530505", debitCents: 15_000 }),
      expect.objectContaining({ accountCode: "11100502", accountId: "aBanco2", creditCents: 15_000 }),
    ]);
  });

  it("rechaza una contrapartida agrupadora o inactiva", async () => {
    for (const accountCode of ["5305", "519595"]) {
      const res = await (PATCH as unknown as H)(req("PATCH", { action: "journalize", lineId: "l1", accountCode }));
      expect(await res.json()).toEqual({ error: "account_not_postable" });
    }
    expect(m.entryCreate).not.toHaveBeenCalled();
  });

  it("rechaza una cuenta de banco que no es del disponible", async () => {
    const res = await (PATCH as unknown as H)(
      req("PATCH", { action: "journalize", lineId: "l1", accountCode: "530505", bankAccountCode: "530505" }),
    );
    expect(await res.json()).toEqual({ error: "bank_account_invalid" });
  });
});

describe("POST importar", () => {
  it("repegar el mismo extracto no duplica", async () => {
    m.lineFindMany.mockResolvedValue([
      { date: new Date("2026-10-05T00:00:00Z"), amountCents: -1_500_000, description: "COMISION" },
    ]);
    const csv = ["Fecha;Descripción;Valor;Saldo", "05/10/2026;COMISION;-15.000;985.000", "06/10/2026;ABONO;100.000;1.085.000"].join("\n");
    const j = await (await (POST as unknown as H)(req("POST", { csv }))).json();
    expect(j).toMatchObject({ imported: 1, duplicates: 1, skipped: 0, byHeader: true });
    expect(m.createMany.mock.calls[0]![0].data).toEqual([
      expect.objectContaining({ description: "ABONO", amountCents: 10_000_000 }),
    ]);
  });
});
