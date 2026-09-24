// Venta a crédito: el asiento de ventas debita Clientes (130505) en vez de
// caja/banco, y el asiento 1b cancela esa CxC con los abonos del mes contra
// la cuenta de dinero donde entró cada uno.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  grossPays: vi.fn(),
  creditPayments: vi.fn(),
  createEntry: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    kushkiTransaction: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
    payment: { groupBy: m.grossPays },
    expense: { findMany: async () => [] },
    expensePayment: { findMany: async () => [] },
    purchasePayment: { findMany: async () => [] },
    customerCreditPayment: { findMany: m.creditPayments },
    deferredItem: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ journalEntry: { deleteMany: async () => ({}), create: m.createEntry } }),
  },
}));
vi.mock("./accountingData", () => ({
  loadSalesBook: async () => ({ totals: { tipCents: 0 } }),
  loadPurchasesBook: async () => ({
    totals: {
      receivedCents: 0, incCents: 0, nonInventoryReceivedCents: 0, nonInventoryIncCents: 0,
      nonInventoryNonDeductibleTaxCents: 0, ivaCents: 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0,
    },
  }),
  computeTaxSummary: async () => ({ sales: { kind: "none", pct: 0, taxCents: 0, byRate: [] } }),
  computeMonthPnl: async () => ({ consumptionCents: 0, wasteCents: 0, labor: null }),
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountIndex: async () =>
    new Map(
      ["110505", "111005", "112005", "130505", "413505"].map((c) => [
        c,
        { id: `id-${c}`, postable: true, active: true },
      ]),
    ),
}));
vi.mock("./activos", () => ({ depreciationLinesForMonth: async () => [] }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));

import { generateJournalForMonth } from "./posting";

type Line = { accountCode: string; accountId: string; debitCents: number; creditCents: number };
type Created = { source: string; lines: { create: Line[] } };
const range = { from: new Date("2026-09-01"), to: new Date("2026-10-01") };

async function entries(): Promise<Created[]> {
  await generateJournalForMonth("r", "2026-09", range);
  return m.createEntry.mock.calls.map((c) => (c[0] as { data: Created }).data);
}
const balanced = (lines: Line[]) => lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0) === 0;

beforeEach(() => {
  vi.clearAllMocks();
  m.grossPays.mockResolvedValue([]);
  m.creditPayments.mockResolvedValue([]);
});

describe("venta a crédito en el asiento de ventas", () => {
  it("debita Clientes (130505) por lo cobrado a crédito y caja por el efectivo", async () => {
    m.grossPays.mockResolvedValue([
      { method: "demo_cash", _sum: { amountCents: 300_000 } },
      { method: "customer_credit", _sum: { amountCents: 200_000 } },
    ]);
    const sale = (await entries()).find((e) => e.source === "sale");
    expect(sale).toBeDefined();
    const lines = sale!.lines.create;
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: "110505", debitCents: 300_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "130505", debitCents: 200_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "413505", creditCents: 500_000, debitCents: 0 }),
      ]),
    );
    expect(lines.some((l) => l.accountCode === "112005")).toBe(false);
    expect(balanced(lines)).toBe(true);
  });
});

describe("asiento 1b — abonos de clientes", () => {
  it("debita cada cuenta de dinero y acredita Clientes por el total, agrupado por cuenta", async () => {
    m.creditPayments.mockResolvedValue([
      { amountCents: 50_000, accountCode: "110505" },
      { amountCents: 30_000, accountCode: "111005" },
      { amountCents: 20_000, accountCode: "110505" },
    ]);
    const all = await entries();
    const entry = all.find((e) => e.source === "customer_credit_payment");
    expect(entry).toBeDefined();
    const lines = entry!.lines.create;
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: "110505", accountId: "id-110505", debitCents: 70_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "111005", debitCents: 30_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "130505", accountId: "id-130505", creditCents: 100_000, debitCents: 0 }),
      ]),
    );
    expect(balanced(lines)).toBe(true);
    // Sin ventas del mes no hay asiento "sale": sólo el de abonos.
    expect(all.map((e) => e.source)).toEqual(["customer_credit_payment"]);
  });

  it("sin abonos (o con montos en 0) no genera el asiento", async () => {
    m.creditPayments.mockResolvedValue([{ amountCents: 0, accountCode: "110505" }]);
    const all = await entries();
    expect(all.some((e) => e.source === "customer_credit_payment")).toBe(false);
  });

  it("devuelve el total del asiento en el resultado", async () => {
    m.creditPayments.mockResolvedValue([{ amountCents: 12_345, accountCode: "112005" }]);
    const results = await generateJournalForMonth("r", "2026-09", range);
    expect(results).toContainEqual({ source: "customer_credit_payment", totalCents: 12_345 });
  });
});
