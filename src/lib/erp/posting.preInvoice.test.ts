// Factura emitida ANTES de cobrar: la venta entra a los libros como
// siempre — por la cuenta COBRADA (día del pago), con el impuesto que
// congeló su factura — y una sola vez, aunque la factura haya salido antes
// y el cobro venga dividido entre varios pagos con una propina distinta de
// la sugerida.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ orders: vi.fn(), createEntry: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: {
      findUnique: async () => ({ businessDayCutoffHour: 5, salesTaxKind: "inc", salesTaxPct: 8 }),
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
      ["110505", "413505", "241205", "24080501", "238030"].map((c) => [
        c,
        { id: c, postable: true, active: true },
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

describe("asiento de ventas — factura emitida antes de cobrar", () => {
  /** Lo que congela la factura: venta de $108.000 con INC 8% (sin propina). */
  const FROZEN = {
    subtotalCents: 10_800_000,
    salesTaxKind: "inc",
    salesTaxPct: 8,
    embeddedTaxCents: 800_000,
    embeddedBaseCents: 10_000_000,
    tipCents: 0,
    totalCents: 10_800_000,
  };
  /** Cobrada en dos pagos; el segundo dejó $5.000 de propina. */
  const paid = (snapshot: Record<string, unknown>) => ({
    paidAt: new Date("2026-09-10T18:00:00Z"),
    status: "paid",
    subtotalCents: 10_800_000,
    tipCents: 500_000,
    invoiceSnapshot: snapshot,
    payments: [
      { method: "cash", amountCents: 6_000_000 },
      { method: "cash", amountCents: 5_300_000 },
    ],
  });

  it("una sola venta, igual al centavo que si la factura hubiera salido al cobrar", async () => {
    m.orders.mockResolvedValue([
      paid({ ...FROZEN, issuedBeforePayment: true, orderItemIds: ["it-1"], paidAtIso: "2026-09-10T17:30:00Z" }),
    ]);
    const preIssued = await salesEntryLines();
    const sales = m.createEntry.mock.calls.filter(
      (c) => (c[0] as { data: { source: string } }).data.source === "sale",
    );
    expect(sales).toHaveLength(1);
    expect(preIssued).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: "110505", debitCents: 11_300_000 }),
        // Ingreso = cobrado − impuesto congelado − propina.
        expect.objectContaining({ accountCode: "413505", creditCents: 11_300_000 - 800_000 - 500_000 }),
        expect.objectContaining({ accountCode: "241205", creditCents: 800_000 }),
        expect.objectContaining({ accountCode: "238030", creditCents: 500_000 }),
      ]),
    );
    expect(preIssued.reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(0);

    vi.clearAllMocks();
    m.orders.mockResolvedValue([paid(FROZEN)]);
    expect(await salesEntryLines()).toEqual(preIssued);
  });

  it("facturada pero todavía sin cobrar: no entra (la venta entra el día que se cobra)", async () => {
    // `loadSalesPostingOrders` sólo trae cuentas con `paidAt` en el rango;
    // una cuenta abierta con factura no aparece.
    m.orders.mockResolvedValue([]);
    await generateJournalForMonth("r", "2026-09", {
      from: new Date("2026-09-01"),
      to: new Date("2026-10-01"),
    });
    const sales = m.createEntry.mock.calls.filter(
      (c) => (c[0] as { data: { source: string } }).data.source === "sale",
    );
    expect(sales).toHaveLength(0);
  });
});
