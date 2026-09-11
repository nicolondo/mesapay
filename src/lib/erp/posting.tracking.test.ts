import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ purchases: vi.fn(), createEntry: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  kushkiTransaction: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
  payment: { groupBy: async () => [] }, expense: { findMany: async () => [] }, expensePayment: { findMany: async () => [] },
  $transaction: async (fn: (tx: unknown) => unknown) => fn({ journalEntry: { deleteMany: async () => ({}), create: mocks.createEntry } }),
} }));
vi.mock("./accountingData", () => ({
  loadSalesBook: async () => ({ totals: { tipCents: 0 } }), loadPurchasesBook: mocks.purchases,
  computeTaxSummary: async () => ({ sales: { kind: "none", taxCents: 0 } }),
  computeMonthPnl: async () => ({ consumptionCents: 0, wasteCents: 0, labor: null }),
}));
vi.mock("./ledger", () => ({ ensureChartOfAccounts: vi.fn(), loadAccountMap: async () => new Map(["143505", "519505", "24081001", "220505", "236505", "236705", "236805"].map((code) => [code, code])) }));
vi.mock("./activos", () => ({ depreciationForMonth: async () => 0 }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
import { generateJournalForMonth } from "./posting";

beforeEach(() => vi.clearAllMocks());
describe("non-stock purchase journal", () => {
  it.each([0, 1900])("balances mixed inventory and expense while preserving VAT deductibility=%i", async (nonInventoryNonDeductibleTaxCents) => {
    mocks.purchases.mockResolvedValue({ totals: { receivedCents: 30000, incCents: 3000, nonInventoryReceivedCents: 10000, nonInventoryIncCents: 1000,
      nonInventoryNonDeductibleTaxCents, ivaCents: 5700, retefuenteCents: 500, reteIvaCents: 0, reteIcaCents: 0 } });
    await generateJournalForMonth("r", "2026-09", { from: new Date("2026-09-01"), to: new Date("2026-10-01") });
    const entry = mocks.createEntry.mock.calls[0][0].data;
    expect(entry.source).toBe("purchase");
    const lines = entry.lines.create as { accountCode: string; debitCents: number; creditCents: number }[];
    expect(lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountCode: "143505", debitCents: 22000 }),
      expect.objectContaining({ accountCode: "519505", debitCents: 11000 + nonInventoryNonDeductibleTaxCents }),
      expect.objectContaining({ accountCode: "24081001", debitCents: 5700 - nonInventoryNonDeductibleTaxCents }),
      expect.objectContaining({ accountCode: "220505", creditCents: 38200 }),
    ]));
    expect(lines.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0)).toBe(0);
    expect(mocks.createEntry).toHaveBeenCalledOnce();
  });
});
