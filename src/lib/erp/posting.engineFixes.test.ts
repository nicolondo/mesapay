// Tres arreglos del motor que pesan más desde que los meses abiertos se
// regeneran solos todos los días:
//  · una fuente que el mes ya no produce pierde su asiento viejo (antes
//    quedaba huérfano), sin tocar numerados, anulados ni manuales;
//  · la nómina ESTIMADA (salarios de hoy) sólo se asienta en el mes en
//    curso — un mes pasado no sigue la planta de hoy;
//  · los gastos se asientan por cuenta Y centro de costos.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  expenses: vi.fn(),
  createEntry: vi.fn(),
  deleteMany: vi.fn(),
  pnl: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    payment: { groupBy: async () => [] },
    expense: { findMany: m.expenses },
    expensePayment: { findMany: async () => [] },
    purchasePayment: { findMany: async () => [] },
    customerCreditPayment: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ journalEntry: { deleteMany: m.deleteMany, create: m.createEntry } }),
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
  computeMonthPnl: m.pnl,
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountIndex: async () =>
    new Map(["510506", "250505", "512010", "233505"].map((code) => [code, { id: code, postable: true, active: true }])),
}));
vi.mock("./activos", () => ({ depreciationLinesForMonth: async () => [] }));
vi.mock("./deferred", () => ({ deferredAmortizationLinesForMonth: async () => [] }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
vi.mock("./creditNoteAccounting", () => ({
  loadCreditNoteMonthPosting: async () => ({ notes: [], noteIds: [] }),
  loadRefundMonthPosting: async () => ({ totalCents: 0, liabilityCents: 0 }),
}));

import { generateJournalForMonth, payrollEstimateApplies } from "./posting";
import { ENGINE_SOURCES } from "./engineCodes";

const OCT = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
const IN_NOVEMBER = new Date("2026-11-15T10:30:00Z");

const created = () => m.createEntry.mock.calls.map((c) => c[0].data as { source: string; lines: { create: Array<Record<string, unknown>> } });

beforeEach(() => {
  vi.resetAllMocks();
  m.expenses.mockResolvedValue([]);
  m.deleteMany.mockResolvedValue({ count: 0 });
  m.createEntry.mockResolvedValue({});
  m.pnl.mockResolvedValue({ consumptionCents: 0, wasteCents: 0, labor: { totalCents: 4_000_000 } });
});

describe("asientos huérfanos", () => {
  it("borra las fuentes del motor que el mes ya no produce, sin tocar numerados ni anulados", async () => {
    // Octubre ya pasó: sin corrida no hay nómina estimada; sin gastos, nada.
    await generateJournalForMonth("r1", "2026-10", OCT, { now: IN_NOVEMBER });
    expect(created()).toEqual([]);
    expect(m.deleteMany).toHaveBeenCalledWith({
      where: {
        restaurantId: "r1",
        sourceRef: "2026-10",
        source: { in: [...ENGINE_SOURCES] },
        voucherNumber: null,
        annulledAt: null,
      },
    });
    // Los manuales nunca son fuente del motor.
    expect(ENGINE_SOURCES).not.toContain("manual" as never);
  });

  it("las fuentes que sí produjo se reemplazan por la vía de siempre, no entran a los huérfanos", async () => {
    m.expenses.mockResolvedValue([{ amountCents: 100_000, category: "Arriendo", accountCode: "512010", costCenterId: null }]);
    await generateJournalForMonth("r1", "2026-10", OCT, { now: IN_NOVEMBER });
    const orphanCall = m.deleteMany.mock.calls.find((c) => "in" in (c[0].where.source ?? {}));
    expect(orphanCall![0].where.source.in).not.toContain("expense");
    expect(created().map((e) => e.source)).toEqual(["expense"]);
  });
});

describe("nómina estimada sin corrida", () => {
  it("se asienta en el mes en curso", async () => {
    const nov = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-12-01T00:00:00Z") };
    await generateJournalForMonth("r1", "2026-11", nov, { now: IN_NOVEMBER });
    expect(created().map((e) => e.source)).toEqual(["payroll"]);
  });

  it("no se asienta en un mes que ya terminó (no sigue la planta de hoy)", async () => {
    await generateJournalForMonth("r1", "2026-10", OCT, { now: IN_NOVEMBER });
    expect(created().map((e) => e.source)).not.toContain("payroll");
  });

  it("el mes termina a la medianoche de Colombia, no a la de UTC", () => {
    // 31-oct a las 10 p. m. en Bogotá (ya 1-nov en UTC): octubre sigue en curso.
    expect(payrollEstimateApplies("2026-10", new Date("2026-11-01T03:00:00Z"))).toBe(true);
    expect(payrollEstimateApplies("2026-10", new Date("2026-11-01T05:00:00Z"))).toBe(false);
    expect(payrollEstimateApplies("2026-12", IN_NOVEMBER)).toBe(true);
  });
});

describe("gastos por centro de costos", () => {
  it("una línea por cuenta y centro, con el centro en la línea", async () => {
    m.pnl.mockResolvedValue({ consumptionCents: 0, wasteCents: 0, labor: null });
    m.expenses.mockResolvedValue([
      { amountCents: 100_000, category: "Gas", accountCode: "512010", costCenterId: "cc-cocina" },
      { amountCents: 50_000, category: "Gas", accountCode: "512010", costCenterId: "cc-cocina" },
      { amountCents: 30_000, category: "Gas", accountCode: "512010", costCenterId: "cc-bar" },
      { amountCents: 20_000, category: "Gas", accountCode: "512010", costCenterId: null },
    ]);
    await generateJournalForMonth("r1", "2026-10", OCT, { now: IN_NOVEMBER });
    const entry = created().find((e) => e.source === "expense")!;
    const debits = entry.lines.create.filter((l) => (l.debitCents as number) > 0);
    expect(debits).toEqual([
      expect.objectContaining({ accountCode: "512010", debitCents: 150_000, costCenterId: "cc-cocina" }),
      expect.objectContaining({ accountCode: "512010", debitCents: 30_000, costCenterId: "cc-bar" }),
      expect.objectContaining({ accountCode: "512010", debitCents: 20_000 }),
    ]);
    expect(debits[2]).not.toHaveProperty("costCenterId");
    expect(entry.lines.create).toContainEqual(expect.objectContaining({ accountCode: "233505", creditCents: 200_000 }));
  });
});
