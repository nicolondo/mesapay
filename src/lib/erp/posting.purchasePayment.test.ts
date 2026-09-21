// Asiento 2b: los abonos a proveedores cancelan la CxP (220505) contra la
// cuenta de donde salió la plata; los viejos sin cuenta caen por heurística.
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  purchases: vi.fn(),
  purchasePayments: vi.fn(),
  createEntry: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    kushkiTransaction: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
    payment: { groupBy: async () => [] },
    expense: { findMany: async () => [] },
    expensePayment: { findMany: async () => [] },
    purchasePayment: { findMany: mocks.purchasePayments },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        journalEntry: { deleteMany: async () => ({}), create: mocks.createEntry },
      }),
  },
}));
vi.mock("./accountingData", () => ({
  loadSalesBook: async () => ({ totals: { tipCents: 0 } }),
  loadPurchasesBook: mocks.purchases,
  computeTaxSummary: async () => ({
    sales: { kind: "none", pct: 0, taxCents: 0, byRate: [] },
  }),
  computeMonthPnl: async () => ({ consumptionCents: 0, wasteCents: 0, labor: null }),
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountMap: async () =>
    new Map(
      ["110505", "111005", "112005", "143505", "519505", "24081001", "220505"].map(
        (code) => [code, code],
      ),
    ),
}));
vi.mock("./activos", () => ({ depreciationForMonth: async () => 0 }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
import { generateJournalForMonth } from "./posting";

type CreatedLine = { accountCode: string; debitCents: number; creditCents: number };
const range = { from: new Date("2026-09-01"), to: new Date("2026-10-01") };

beforeEach(() => {
  vi.clearAllMocks();
  // Sin compras del mes: sólo interesa el asiento de pagos.
  mocks.purchases.mockResolvedValue({
    totals: {
      receivedCents: 0,
      incCents: 0,
      nonInventoryReceivedCents: 0,
      nonInventoryIncCents: 0,
      nonInventoryNonDeductibleTaxCents: 0,
      ivaCents: 0,
      retefuenteCents: 0,
      reteIvaCents: 0,
      reteIcaCents: 0,
    },
  });
});

describe("asiento de pagos a proveedores", () => {
  it("debita proveedores y acredita cada cuenta de origen, resolviendo los abonos viejos", async () => {
    mocks.purchasePayments.mockResolvedValue([
      { amountCents: 30000, accountCode: "110505", method: null },
      { amountCents: 20000, accountCode: "111005", method: null },
      // Abono anterior al campo: cae en bancos por el texto del método.
      { amountCents: 5000, accountCode: null, method: "transferencia" },
    ]);
    const results = await generateJournalForMonth("r", "2026-09", range);

    expect(mocks.createEntry).toHaveBeenCalledOnce();
    const entry = mocks.createEntry.mock.calls[0][0].data;
    expect(entry.source).toBe("purchase_payment");
    expect(entry.sourceRef).toBe("2026-09");
    const lines = entry.lines.create as CreatedLine[];
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: "220505", debitCents: 55000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "110505", creditCents: 30000, debitCents: 0 }),
        expect.objectContaining({ accountCode: "111005", creditCents: 25000, debitCents: 0 }),
      ]),
    );
    expect(lines.reduce((sum, l) => sum + l.debitCents - l.creditCents, 0)).toBe(0);
    expect(results).toEqual([{ source: "purchase_payment", totalCents: 55000 }]);
  });

  it("sin abonos en el mes no crea ningún asiento de esa fuente", async () => {
    mocks.purchasePayments.mockResolvedValue([]);
    const results = await generateJournalForMonth("r", "2026-09", range);
    expect(results.some((r) => r.source === "purchase_payment")).toBe(false);
    expect(mocks.createEntry).not.toHaveBeenCalled();
  });

  it("ignora abonos con monto 0 o negativo", async () => {
    mocks.purchasePayments.mockResolvedValue([
      { amountCents: 0, accountCode: "110505", method: null },
      { amountCents: -100, accountCode: "110505", method: null },
    ]);
    await generateJournalForMonth("r", "2026-09", range);
    expect(mocks.createEntry).not.toHaveBeenCalled();
  });
});
