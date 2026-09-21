// Asiento 6b "Depreciación del mes": un resumen `depreciation` por mes con la
// cuota de cada activo contra SUS cuentas (gasto 5xxx / acumulada 15xx),
// agregadas por cuenta — ya no el par fijo 516005/159205.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ assets: vi.fn(), createEntry: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    kushkiTransaction: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
    payment: { groupBy: async () => [] },
    expense: { findMany: async () => [] },
    expensePayment: { findMany: async () => [] },
    purchasePayment: { findMany: async () => [] },
    deferredItem: { findMany: async () => [] },
    fixedAsset: { findMany: m.assets },
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
      ["516005", "159205", "516010", "159210"].map((c) => [
        c,
        { id: `id-${c}`, postable: true, active: true },
      ]),
    ),
}));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
import { generateJournalForMonth } from "./posting";

type CreatedLine = { accountId: string; accountCode: string; debitCents: number; creditCents: number };

const range = { from: new Date("2026-09-01"), to: new Date("2026-10-01") };

// Horno: 12M a 12 meses desde 2026-02 → 1.000.000/mes contra las cuentas default.
const horno = {
  purchaseCents: 12_000_000, salvageCents: 0, purchaseDate: new Date("2026-01-15T00:00:00Z"), usefulLifeMonths: 12,
  active: true, disposedAt: null, expenseAccountCode: "516005", depreciationAccountCode: "159205",
};
// Camioneta: 60M a 60 meses desde 2026-01 → 1.000.000/mes contra cuentas propias.
const camioneta = {
  purchaseCents: 60_000_000, salvageCents: 0, purchaseDate: new Date("2025-12-01T00:00:00Z"), usefulLifeMonths: 60,
  active: true, disposedAt: null, expenseAccountCode: "516010", depreciationAccountCode: "159210",
};

beforeEach(() => vi.clearAllMocks());

describe("asiento de depreciación por cuentas de cada activo", () => {
  it("dos activos con cuentas distintas → cuatro líneas, cada cuota en SUS cuentas, cuadrado", async () => {
    m.assets.mockResolvedValue([horno, camioneta]);
    const results = await generateJournalForMonth("r", "2026-09", range);

    expect(m.createEntry).toHaveBeenCalledOnce();
    const entry = m.createEntry.mock.calls[0][0].data;
    expect(entry.source).toBe("depreciation");
    expect(entry.sourceRef).toBe("2026-09");
    expect(entry.memo).toBe("Depreciación del mes");
    const lines = entry.lines.create as CreatedLine[];
    expect(lines).toHaveLength(4);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: "516005", accountId: "id-516005", debitCents: 1_000_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "159205", accountId: "id-159205", debitCents: 0, creditCents: 1_000_000 }),
        expect.objectContaining({ accountCode: "516010", accountId: "id-516010", debitCents: 1_000_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "159210", accountId: "id-159210", debitCents: 0, creditCents: 1_000_000 }),
      ]),
    );
    expect(lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(0);
    expect(results).toEqual([{ source: "depreciation", totalCents: 2_000_000 }]);
  });

  it("dos activos con las mismas cuentas se agregan en un solo par", async () => {
    m.assets.mockResolvedValue([horno, { ...camioneta, expenseAccountCode: "516005", depreciationAccountCode: "159205" }]);
    await generateJournalForMonth("r", "2026-09", range);
    const lines = m.createEntry.mock.calls[0][0].data.lines.create as CreatedLine[];
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: "516005", debitCents: 2_000_000 }),
        expect.objectContaining({ accountCode: "159205", creditCents: 2_000_000 }),
      ]),
    );
  });

  it("un activo dado de baja el mes pasado no deprecia este mes", async () => {
    m.assets.mockResolvedValue([
      { ...horno, active: false, disposedAt: new Date("2026-08-20T10:00:00Z") },
      camioneta,
    ]);
    await generateJournalForMonth("r", "2026-09", range);
    const lines = m.createEntry.mock.calls[0][0].data.lines.create as CreatedLine[];
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.accountCode === "516005" || l.accountCode === "159205")).toBe(false);
  });

  it("sin activos (o fuera de su vida) no genera nada", async () => {
    m.assets.mockResolvedValue([]);
    await generateJournalForMonth("r", "2026-09", range);
    expect(m.createEntry).not.toHaveBeenCalled();
    m.assets.mockResolvedValue([horno]);
    const results = await generateJournalForMonth("r", "2027-06", {
      from: new Date("2027-06-01"),
      to: new Date("2027-07-01"),
    });
    expect(m.createEntry).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
