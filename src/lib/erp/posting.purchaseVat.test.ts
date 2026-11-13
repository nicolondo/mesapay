// «Compras del día» según el IVA de compras sea descontable o no
// (`Restaurant.purchaseIvaDeductible`). No descontable: el IVA es costo —el
// de las líneas inventariables va a 143505 (el kardex ya valoró esa
// mercancía al bruto) y el de las no inventariables al gasto—; nada a 2408.
// Antes el de las inventariables se debitaba a 24081001 aunque el
// inventario ya lo incluía: contado dos veces. Descontable: igual que
// siempre.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ purchases: vi.fn(), createEntry: vi.fn() }));
// Pagos con comprobante (bloque 10): este test no los ejercita.
vi.mock("./supplierPaymentPosting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supplierPaymentPosting")>()),
  loadSupplierPaymentFacts: async () => ({ payments: [], voids: [] }),
  firstSupplierPaymentActivity: async () => null,
}));
// Notas crédito de proveedores (bloque 9): este test no las ejercita.
vi.mock("./supplierCreditNotePosting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supplierCreditNotePosting")>()),
  loadSupplierCreditFacts: async () => ({ notes: [], voids: [], applies: [], refunds: [] }),
  firstSupplierCreditActivity: async () => null,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: async () => ({ businessDayCutoffHour: 5, salesTaxKind: "none", salesTaxPct: 0 }) },
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
  loadSalesPostingOrders: async () => [],
  loadPurchasesBook: m.purchases,
  computeMonthLabor: async () => null,
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountIndex: async () =>
    new Map(
      ["143505", "519505", "24081001", "220505", "236505", "236705", "236805"].map((code) => [
        code,
        { id: code, postable: true, active: true },
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
import type { PurchaseBookRowAmounts } from "./purchaseTax";

type Line = { accountCode: string; debitCents: number; creditCents: number };

/** Una factura recibida el 10-sep con sus montos del libro de compras. */
function row(over: Partial<PurchaseBookRowAmounts>) {
  return {
    receivedAt: new Date("2026-09-10T15:00:00Z"),
    receivedCents: 0,
    nonInventoryReceivedCents: 0,
    nonInventoryNonDeductibleTaxCents: 0,
    inventoryNonDeductibleTaxCents: 0,
    nonInventoryIncCents: 0,
    ivaCents: 0,
    incCents: 0,
    retefuenteCents: 0,
    reteIvaCents: 0,
    reteIcaCents: 0,
    ...over,
  };
}

async function purchaseLines(rows: ReturnType<typeof row>[]): Promise<Map<string, number>> {
  m.purchases.mockResolvedValue({ rows, totals: {} });
  await generateJournalForMonth("r", "2026-09", { from: new Date("2026-09-01"), to: new Date("2026-10-01") });
  const entries = m.createEntry.mock.calls.map((c) => (c[0] as { data: { source: string; date: Date; lines: { create: Line[] } } }).data);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.source).toBe("purchase");
  expect(entries[0]!.date).toEqual(new Date("2026-09-10T05:00:00.000Z"));
  const lines = entries[0]!.lines.create;
  expect(lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(0);
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.accountCode, (out.get(l.accountCode) ?? 0) + l.debitCents - l.creditCents);
  return out;
}

beforeEach(() => vi.clearAllMocks());

describe("asiento de compras — IVA descontable vs mayor valor del costo", () => {
  it("descontable: inventario al neto y el IVA a 24081001, como siempre", async () => {
    const net = await purchaseLines([row({ receivedCents: 100_000, ivaCents: 19_000 })]);
    expect([...net.entries()]).toEqual([
      ["143505", 100_000],
      ["24081001", 19_000],
      ["220505", -119_000],
    ]);
  });

  it("no descontable: el IVA de la línea inventariable va al inventario y no a 2408", async () => {
    const net = await purchaseLines([
      row({ receivedCents: 100_000, ivaCents: 19_000, inventoryNonDeductibleTaxCents: 19_000 }),
    ]);
    expect([...net.entries()]).toEqual([
      ["143505", 119_000],
      ["220505", -119_000],
    ]);
  });

  it("no descontable, inventario + no inventariable + INC + retención: nada a 2408", async () => {
    // Mismos montos que posting.tracking.test: 30.000 neto (10.000 no
    // inventariable), INC 3.000 (1.000 del no inventariable), IVA 5.700
    // (1.900 del no inventariable, congelado al recibir) y retefuente 500.
    const net = await purchaseLines([
      row({
        receivedCents: 30_000,
        incCents: 3_000,
        nonInventoryReceivedCents: 10_000,
        nonInventoryIncCents: 1_000,
        nonInventoryNonDeductibleTaxCents: 1_900,
        inventoryNonDeductibleTaxCents: 3_800,
        ivaCents: 5_700,
        retefuenteCents: 500,
      }),
    ]);
    expect(net.get("143505")).toBe(20_000 + 2_000 + 3_800);
    expect(net.get("519505")).toBe(10_000 + 1_000 + 1_900);
    expect(net.has("24081001")).toBe(false);
    expect(net.get("236505")).toBe(-500);
    expect(net.get("220505")).toBe(-(33_000 + 5_700 - 500));
  });

  it("varias facturas el mismo día suman como el libro", async () => {
    const net = await purchaseLines([
      row({ receivedCents: 100_000, ivaCents: 19_000, inventoryNonDeductibleTaxCents: 19_000 }),
      row({ receivedCents: 50_000, ivaCents: 2_500, inventoryNonDeductibleTaxCents: 2_500 }),
    ]);
    expect(net.get("143505")).toBe(171_500);
    expect(net.has("24081001")).toBe(false);
    expect(net.get("220505")).toBe(-171_500);
  });

  it("nunca capitaliza más IVA del que hay: el asiento cuadra aunque los datos vengan raros", async () => {
    const net = await purchaseLines([
      row({ receivedCents: 100_000, ivaCents: 19_000, nonInventoryNonDeductibleTaxCents: 10_000, nonInventoryReceivedCents: 50_000, inventoryNonDeductibleTaxCents: 19_000 }),
    ]);
    expect(net.get("143505")).toBe(50_000 + 9_000);
    expect(net.get("519505")).toBe(60_000);
    expect(net.has("24081001")).toBe(false);
    expect(net.get("220505")).toBe(-119_000);
  });
});
