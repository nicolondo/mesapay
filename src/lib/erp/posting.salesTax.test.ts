// El asiento "Ventas del mes" acredita el impuesto por TRAMO (lo que cada
// factura congeló, agrupado por tarifa): un mes en el que el comercio
// cambió de tarifa lleva 241205 (INC) y el auxiliar de IVA a la vez.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ tax: vi.fn(), createEntry: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    kushkiTransaction: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
    payment: {
      groupBy: async () => [{ method: "cash", _sum: { amountCents: 5_200_000 } }],
    },
    expense: { findMany: async () => [] },
    expensePayment: { findMany: async () => [] },
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
  computeTaxSummary: m.tax,
  computeMonthPnl: async () => ({ consumptionCents: 0, wasteCents: 0, labor: null }),
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountMap: async () =>
    new Map(["110505", "413505", "241205", "24080501", "238030"].map((c) => [c, c])),
}));
vi.mock("./activos", () => ({ depreciationForMonth: async () => 0 }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));

import { generateJournalForMonth } from "./posting";

type Line = { accountCode: string; debitCents: number; creditCents: number };

async function salesEntryLines(): Promise<Line[]> {
  await generateJournalForMonth("r", "2026-09", {
    from: new Date("2026-09-01"),
    to: new Date("2026-10-01"),
  });
  const entry = m.createEntry.mock.calls
    .map((c) => (c[0] as { data: { source: string; lines: { create: Line[] } } }).data)
    .find((d) => d.source === "sale");
  expect(entry).toBeDefined();
  return entry!.lines.create;
}

beforeEach(() => vi.clearAllMocks());

describe("asiento de ventas — impuesto por tramo", () => {
  it("un mes con INC 8% e IVA 19% lleva un crédito por cada código y cuadra", async () => {
    m.tax.mockResolvedValue({
      sales: {
        kind: "inc", pct: 8, grossCents: 5_200_000, taxCents: 381_886, baseCents: 4_818_114,
        byRate: [
          { kind: "inc", pct: 8, grossCents: 3_000_000, taxCents: 222_222, baseCents: 2_777_778 },
          { kind: "iva", pct: 19, grossCents: 1_000_000, taxCents: 159_664, baseCents: 840_336 },
        ],
      },
      purchases: { ivaCents: 0, incCents: 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0 },
    });
    const lines = await salesEntryLines();
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: "110505", debitCents: 5_200_000 }),
        expect.objectContaining({ accountCode: "413505", creditCents: 5_200_000 - 381_886 }),
        expect.objectContaining({ accountCode: "241205", creditCents: 222_222 }),
        expect.objectContaining({ accountCode: "24080501", creditCents: 159_664 }),
      ]),
    );
    expect(lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(0);
  });

  it("sin tramos (facturas emitidas sin impuesto) no hay crédito de impuesto aunque el mes se etiquete INC", async () => {
    // Comercio recién pasado a INC 8%: el mes queda etiquetado así, pero lo
    // facturado salió en cero y el asiento no inventa el 8%.
    m.tax.mockResolvedValue({
      sales: { kind: "inc", pct: 8, grossCents: 5_200_000, taxCents: 0, baseCents: 5_200_000, byRate: [] },
      purchases: { ivaCents: 0, incCents: 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0 },
    });
    const lines = await salesEntryLines();
    expect(lines.map((l) => l.accountCode)).toEqual(["110505", "413505"]);
    expect(lines[1].creditCents).toBe(5_200_000);
  });
});
