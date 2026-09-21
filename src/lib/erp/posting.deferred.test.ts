// Asiento 6c "Amortización de diferidos del mes": un resumen `deferred` por
// mes con las cuotas de todos los diferidos, agregadas por cuenta y centro
// de costos, que el motor regenera como cualquier otra fuente.
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ items: vi.fn(), createEntry: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    kushkiTransaction: { aggregate: async () => ({ _sum: { amountCents: 0 } }) },
    payment: { groupBy: async () => [] },
    expense: { findMany: async () => [] },
    expensePayment: { findMany: async () => [] },
    purchasePayment: { findMany: async () => [] },
    deferredItem: { findMany: m.items },
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
      ["170505", "270505", "513005", "429505"].map((c) => [
        c,
        { id: `id-${c}`, postable: true, active: true },
      ]),
    ),
}));
vi.mock("./activos", () => ({ depreciationForMonth: async () => 0 }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
import { generateJournalForMonth } from "./posting";

type CreatedLine = {
  accountId: string;
  accountCode: string;
  debitCents: number;
  creditCents: number;
  costCenterId?: string;
};

const range = { from: new Date("2026-09-01"), to: new Date("2026-10-01") };

const seguro = {
  kind: "expense", totalCents: 1_200_000, startDate: new Date("2026-01-15T12:00:00Z"), months: 12,
  deferralAccountCode: "170505", targetAccountCode: "513005", costCenterId: "cc-cocina",
  status: "active", closedAt: null,
};
const anticipo = {
  kind: "income", totalCents: 900_000, startDate: new Date("2026-07-01T12:00:00Z"), months: 6,
  deferralAccountCode: "270505", targetAccountCode: "429505", costCenterId: null,
  status: "active", closedAt: null,
};

beforeEach(() => vi.clearAllMocks());

describe("asiento de amortización de diferidos", () => {
  it("un gasto con centro y un ingreso generan un asiento `deferred` cuadrado con las cuentas correctas", async () => {
    m.items.mockResolvedValue([seguro, anticipo]);
    const results = await generateJournalForMonth("r", "2026-09", range);

    expect(m.createEntry).toHaveBeenCalledOnce();
    const entry = m.createEntry.mock.calls[0][0].data;
    expect(entry.source).toBe("deferred");
    expect(entry.sourceRef).toBe("2026-09");
    expect(entry.memo).toBe("Amortización de diferidos del mes");
    const lines = entry.lines.create as CreatedLine[];
    expect(lines).toHaveLength(4);
    expect(lines).toEqual(
      expect.arrayContaining([
        // expense: D gasto / C puente 17, ambas con el centro del ítem.
        expect.objectContaining({ accountCode: "513005", accountId: "id-513005", debitCents: 100_000, creditCents: 0, costCenterId: "cc-cocina" }),
        expect.objectContaining({ accountCode: "170505", accountId: "id-170505", debitCents: 0, creditCents: 100_000, costCenterId: "cc-cocina" }),
        // income: D puente 27 / C ingreso, sin centro.
        expect.objectContaining({ accountCode: "270505", debitCents: 150_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "429505", debitCents: 0, creditCents: 150_000 }),
      ]),
    );
    // Las líneas sin centro no llevan la clave (create idéntico al de antes).
    expect(lines.find((l) => l.accountCode === "270505")).not.toHaveProperty("costCenterId");
    expect(lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(0);
    expect(results).toEqual([{ source: "deferred", totalCents: 250_000 }]);
  });

  it("un diferido dado de baja el mes pasado no amortiza este mes", async () => {
    m.items.mockResolvedValue([
      { ...seguro, status: "closed", closedAt: new Date("2026-08-20T10:00:00Z") },
      anticipo,
    ]);
    await generateJournalForMonth("r", "2026-09", range);
    const lines = m.createEntry.mock.calls[0][0].data.lines.create as CreatedLine[];
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.accountCode === "513005" || l.accountCode === "170505")).toBe(false);
    expect(lines.reduce((s, l) => s + l.debitCents, 0)).toBe(150_000);
  });

  it("un mes fuera de la vida de todos los diferidos no genera nada", async () => {
    m.items.mockResolvedValue([seguro, anticipo]);
    const results = await generateJournalForMonth("r", "2027-03", {
      from: new Date("2027-03-01"),
      to: new Date("2027-04-01"),
    });
    expect(m.createEntry).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("sin diferidos no genera nada", async () => {
    m.items.mockResolvedValue([]);
    await generateJournalForMonth("r", "2026-09", range);
    expect(m.createEntry).not.toHaveBeenCalled();
  });
});
