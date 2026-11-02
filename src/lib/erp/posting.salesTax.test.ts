// El asiento «Ventas del día» acredita el impuesto por TRAMO (lo que cada
// factura congeló, agrupado por tarifa): un día en el que el comercio
// cambió de tarifa lleva 241205 (INC) y el auxiliar de IVA a la vez.
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

/** Pedido pagado en efectivo el 10-sep, con el snapshot que congeló su factura. */
const order = (subtotalCents: number, invoiceSnapshot: Record<string, unknown>) => ({
  paidAt: new Date("2026-09-10T18:00:00Z"),
  status: "paid",
  subtotalCents,
  tipCents: 0,
  invoiceSnapshot,
  payments: [{ method: "cash", amountCents: subtotalCents }],
});
/** Bandeja de $30.000 con INC 8% congelado (mismo reparto que el XML). */
const INC_8 = { subtotalCents: 3_000_000, salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 222_222, embeddedBaseCents: 2_777_778 };
/** $10.000 con IVA 19% congelado. */
const IVA_19 = { subtotalCents: 1_000_000, salesTaxKind: "iva", salesTaxPct: 19, embeddedTaxCents: 159_664, embeddedBaseCents: 840_336 };
/** Emitida con el comercio en "none", a propósito. */
const NONE = (subtotalCents: number) => ({ subtotalCents, salesTaxKind: "none", salesTaxPct: 0, embeddedTaxCents: 0, embeddedBaseCents: subtotalCents });

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
  it("un día con INC 8% e IVA 19% lleva un crédito por cada código y cuadra", async () => {
    m.orders.mockResolvedValue([
      order(3_000_000, INC_8),
      order(1_000_000, IVA_19),
      order(1_200_000, NONE(1_200_000)),
    ]);
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

  it("sin tramos (facturas emitidas sin impuesto) no hay crédito de impuesto aunque el comercio esté en INC", async () => {
    // Comercio recién pasado a INC 8%: lo facturado salió en cero y el
    // asiento no inventa el 8%.
    m.orders.mockResolvedValue([order(5_200_000, NONE(5_200_000))]);
    const lines = await salesEntryLines();
    expect(lines.map((l) => l.accountCode)).toEqual(["110505", "413505"]);
    expect(lines[1].creditCents).toBe(5_200_000);
  });

  it("una venta sin factura lleva la tarifa actual del comercio", async () => {
    m.orders.mockResolvedValue([{ ...order(250_000, NONE(0)), invoiceSnapshot: null }]);
    const lines = await salesEntryLines();
    expect(lines).toEqual([
      expect.objectContaining({ accountCode: "110505", debitCents: 250_000 }),
      expect.objectContaining({ accountCode: "413505", creditCents: 231_481 }),
      expect.objectContaining({ accountCode: "241205", creditCents: 18_519 }),
    ]);
  });
});
