// Efectivo en el asiento de ventas: `cash` (el método actual) y el
// histórico `demo_cash` debitan Caja (110505), consolidados en una sola
// línea; lo que entró por pasarela sigue yendo a 112005.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ orders: vi.fn(), createEntry: vi.fn() }));
// Notas crédito de proveedores (bloque 9): este test no las ejercita.
vi.mock("./supplierCreditNotePosting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supplierCreditNotePosting")>()),
  loadSupplierCreditFacts: async () => ({ notes: [], voids: [], applies: [], refunds: [] }),
  firstSupplierCreditActivity: async () => null,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: {
      findUnique: async () => ({ businessDayCutoffHour: 5, salesTaxKind: "none", salesTaxPct: 0 }),
    },
    stockMovement: { findMany: async () => [] },
    expense: { findMany: async () => [] },
    expensePayment: { findMany: async () => [] },
    purchasePayment: { findMany: async () => [] },
    customerCreditPayment: { findMany: async () => [] },
    deferredItem: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ journalEntry: { deleteMany: async () => ({}), create: m.createEntry } }),
  },
}));
vi.mock("./accountingData", () => ({
  loadSalesPostingOrders: m.orders,
  loadPurchasesBook: async () => ({ rows: [], totals: {} }),
  computeMonthLabor: async () => null,
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountIndex: async () =>
    new Map(
      ["110505", "111005", "112005", "413505"].map((c) => [
        c,
        { id: `id-${c}`, postable: true, active: true },
      ]),
    ),
}));
vi.mock("./activos", () => ({ depreciationLinesForMonth: async () => [] }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
vi.mock("./creditNoteAccounting", () => ({
  loadCreditNoteMonthPosting: async () => ({ notes: [], noteIds: [] }),
  loadRefundMonthPosting: async () => ({ refunds: [], totalCents: 0, liabilityCents: 0 }),
}));

import { generateJournalForMonth } from "./posting";

type Line = { accountCode: string; debitCents: number; creditCents: number };

/** Un pedido pagado el 10-sep con los cobros dados. */
const order = (payments: Array<[string, number]>) => ({
  paidAt: new Date("2026-09-10T18:00:00Z"),
  status: "paid",
  subtotalCents: payments.reduce((s, [, c]) => s + c, 0),
  tipCents: 0,
  invoiceSnapshot: null,
  payments: payments.map(([method, amountCents]) => ({ method, amountCents })),
});

async function saleLines(): Promise<Line[]> {
  await generateJournalForMonth("r", "2026-09", { from: new Date("2026-09-01"), to: new Date("2026-10-01") });
  const sale = m.createEntry.mock.calls
    .map((c) => (c[0] as { data: { source: string; lines: { create: Line[] } } }).data)
    .find((d) => d.source === "sale");
  expect(sale).toBeDefined();
  return sale!.lines.create;
}

beforeEach(() => vi.clearAllMocks());

describe("efectivo en el asiento de ventas", () => {
  it("cash debita Caja (110505)", async () => {
    m.orders.mockResolvedValue([order([["cash", 300_000]])]);
    const lines = await saleLines();
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: "110505", debitCents: 300_000, creditCents: 0 }),
        expect.objectContaining({ accountCode: "413505", creditCents: 300_000, debitCents: 0 }),
      ]),
    );
    expect(lines.some((l) => l.accountCode === "112005")).toBe(false);
  });

  it("cash y el histórico demo_cash van a una sola línea de Caja; la pasarela aparte", async () => {
    m.orders.mockResolvedValue([
      order([["cash", 300_000]]),
      order([["demo_cash", 200_000], ["kushki_card", 100_000]]),
    ]);
    const lines = await saleLines();
    const caja = lines.filter((l) => l.accountCode === "110505");
    expect(caja).toHaveLength(1);
    expect(caja[0]).toEqual(expect.objectContaining({ debitCents: 500_000, creditCents: 0 }));
    expect(lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ accountCode: "112005", debitCents: 100_000 })]),
    );
    expect(lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(0);
  });
});
