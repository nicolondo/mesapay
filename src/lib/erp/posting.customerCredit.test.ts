// Venta a crédito: el asiento de ventas debita Clientes (130505) en vez de
// caja/banco, y el asiento 1b cancela esa CxC con los abonos del día contra
// la cuenta de dinero donde entró cada uno.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  orders: vi.fn(),
  creditPayments: vi.fn(),
  createEntry: vi.fn(),
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
    customerCreditPayment: { findMany: m.creditPayments },
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
      ["110505", "111005", "112005", "130505", "413505"].map((c) => [
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

type Line = { accountCode: string; accountId: string; debitCents: number; creditCents: number };
type Created = { source: string; lines: { create: Line[] } };
const range = { from: new Date("2026-09-01"), to: new Date("2026-10-01") };
/** Todos los abonos del test caen el 12-sep. */
const PAID_AT = new Date("2026-09-12T16:00:00Z");

async function entries(): Promise<Created[]> {
  await generateJournalForMonth("r", "2026-09", range);
  return m.createEntry.mock.calls.map((c) => (c[0] as { data: Created }).data);
}
const balanced = (lines: Line[]) => lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0) === 0;

beforeEach(() => {
  vi.clearAllMocks();
  m.orders.mockResolvedValue([]);
  m.creditPayments.mockResolvedValue([]);
});

describe("venta a crédito en el asiento de ventas", () => {
  it("debita Clientes (130505) por lo cobrado a crédito y caja por el efectivo", async () => {
    m.orders.mockResolvedValue([
      {
        paidAt: new Date("2026-09-10T18:00:00Z"),
        status: "paid",
        subtotalCents: 500_000,
        tipCents: 0,
        invoiceSnapshot: null,
        payments: [
          { method: "demo_cash", amountCents: 300_000 },
          { method: "customer_credit", amountCents: 200_000 },
        ],
      },
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
      { amountCents: 50_000, accountCode: "110505", paidAt: PAID_AT },
      { amountCents: 30_000, accountCode: "111005", paidAt: PAID_AT },
      { amountCents: 20_000, accountCode: "110505", paidAt: PAID_AT },
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

  it("abonos de días distintos van a asientos distintos, fechados a la medianoche de Bogotá de cada día", async () => {
    m.creditPayments.mockResolvedValue([
      { amountCents: 50_000, accountCode: "110505", paidAt: new Date("2026-09-12T16:00:00Z") },
      // 13-sep a las 2 a. m. de Bogotá (07:00Z): con corte 5 sigue siendo el 12.
      { amountCents: 10_000, accountCode: "110505", paidAt: new Date("2026-09-13T07:00:00Z") },
      // 13-sep a las 6 a. m. de Bogotá: ya es el 13.
      { amountCents: 30_000, accountCode: "111005", paidAt: new Date("2026-09-13T11:00:00Z") },
    ]);
    const created = m.createEntry.mock;
    await generateJournalForMonth("r", "2026-09", range);
    const days = created.calls.map((c) => (c[0] as { data: { date: Date; lines: { create: Line[] } } }).data);
    expect(days.map((d) => d.date.toISOString())).toEqual(["2026-09-12T05:00:00.000Z", "2026-09-13T05:00:00.000Z"]);
    expect(days[0]!.lines.create).toContainEqual(expect.objectContaining({ accountCode: "110505", debitCents: 60_000 }));
    expect(days[1]!.lines.create).toContainEqual(expect.objectContaining({ accountCode: "111005", debitCents: 30_000 }));
  });

  it("sin abonos (o con montos en 0) no genera el asiento", async () => {
    m.creditPayments.mockResolvedValue([{ amountCents: 0, accountCode: "110505", paidAt: PAID_AT }]);
    const all = await entries();
    expect(all.some((e) => e.source === "customer_credit_payment")).toBe(false);
  });

  it("devuelve el total de la fuente en el resultado (Σ de sus asientos del día)", async () => {
    m.creditPayments.mockResolvedValue([
      { amountCents: 12_345, accountCode: "112005", paidAt: PAID_AT },
      { amountCents: 100, accountCode: "112005", paidAt: new Date("2026-09-20T16:00:00Z") },
    ]);
    const results = await generateJournalForMonth("r", "2026-09", range);
    expect(results).toContainEqual({ source: "customer_credit_payment", totalCents: 12_445 });
  });
});
