// Asiento «Gastos del día» con impuestos y retenciones (misma convención
// que las compras). Invariantes:
//  · cada asiento cuadra (débitos = créditos), en todos los casos;
//  · D gasto = COSTO (base + INC + IVA no descontable); D 24081001 sólo el
//    IVA descontable; C cada retención a la cuenta de su concepto; C 233505
//    = TOTAL A PAGAR (base + IVA + INC − retenciones);
//  · el pago (de contado o abonos) cancela 233505 contra caja/banco por lo
//    que salió de caja: el total a pagar, nunca lo retenido;
//  · un gasto sin impuestos (o uno viejo, de antes de esta versión) queda
//    exactamente como antes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expenseAmounts } from "./expenseTax";

const m = vi.hoisted(() => ({
  expenses: vi.fn(),
  expensePays: vi.fn(),
  log: [] as Array<{ op: "delete" | "create"; args: Record<string, unknown> }>,
}));
// Notas crédito de proveedores (bloque 9): este test no las ejercita.
vi.mock("./supplierCreditNotePosting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supplierCreditNotePosting")>()),
  loadSupplierCreditFacts: async () => ({ notes: [], voids: [], applies: [], refunds: [] }),
  firstSupplierCreditActivity: async () => null,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: async () => ({ businessDayCutoffHour: 0, salesTaxKind: "inc", salesTaxPct: 8 }) },
    stockMovement: { findMany: async () => [] },
    expense: { findMany: m.expenses },
    expensePayment: { findMany: m.expensePays },
    purchasePayment: { findMany: async () => [] },
    customerCreditPayment: { findMany: async () => [] },
    deferredItem: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        journalEntry: {
          deleteMany: async (args: { where: Record<string, unknown> }) => {
            m.log.push({ op: "delete", args: args.where });
            return { count: 0 };
          },
          create: async (args: { data: Record<string, unknown> }) => {
            m.log.push({ op: "create", args: args.data });
            return {};
          },
        },
        creditNote: { updateMany: async () => ({ count: 0 }) },
      }),
  },
}));
vi.mock("./accountingData", () => ({
  loadSalesPostingOrders: async () => [],
  loadPurchasesBook: async () => ({ rows: [], totals: {} }),
  computeMonthLabor: async () => null,
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountIndex: async () =>
    new Map(
      [
        "110505", "111005", "233505", "236505", "236515", "236705", "236805", "24081001",
        "511005", "512010", "513505", "514505", "519505",
      ].map((c) => [c, { id: `id-${c}`, postable: true, active: true }]),
    ),
}));
vi.mock("./activos", () => ({ depreciationLinesForMonth: async () => [] }));
vi.mock("./deferred", () => ({ deferredAmortizationLinesForMonth: async () => [] }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
vi.mock("./creditNoteAccounting", () => ({
  loadCreditNoteMonthPosting: async () => ({ notes: [], noteIds: [] }),
  loadRefundMonthPosting: async () => ({ refunds: [], totalCents: 0, liabilityCents: 0 }),
}));

import { generateJournalForMonth } from "./posting";

type Line = { accountCode: string; debitCents: number; creditCents: number; costCenterId?: string };
type Created = { source: string; date: Date; lines: { create: Line[] } };

const OCT = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
const NOW = new Date("2026-11-15T10:30:00Z");
const created = () => m.log.filter((l) => l.op === "create").map((l) => l.args as unknown as Created);
const bySource = (s: string) => created().filter((e) => e.source === s);
const lines = (s: string) => bySource(s).flatMap((e) => e.lines.create);
const net = (s: string, code: string) =>
  lines(s).filter((l) => l.accountCode === code).reduce((a, l) => a + l.debitCents - l.creditCents, 0);
function expectBalanced() {
  for (const e of created()) {
    const d = e.lines.create.reduce((s, l) => s + l.debitCents, 0);
    const c = e.lines.create.reduce((s, l) => s + l.creditCents, 0);
    expect(d, `${e.source} ${e.date.toISOString()}`).toBe(c);
    expect(d).toBeGreaterThan(0);
  }
}

/** Fila de gasto como la lee el motor, armada con el MISMO cálculo de la API. */
function expenseRow(over: {
  subtotal: number;
  ivaPct?: number;
  ivaDeductible?: boolean;
  inc?: number;
  retentions?: Array<{ kind: string; accountCode: string; amountCents: number }>;
  accountCode?: string;
  category?: string;
  day?: string;
  costCenterId?: string | null;
}) {
  const a = expenseAmounts({
    subtotalCents: over.subtotal,
    ivaPct: over.ivaPct ?? 0,
    ivaDeductible: over.ivaDeductible ?? false,
    incCents: over.inc ?? 0,
    retentions: over.retentions ?? [],
  });
  return {
    row: {
      amountCents: a.costCents,
      ivaCents: a.ivaCents,
      ivaDeductible: over.ivaDeductible ?? false,
      category: over.category ?? "Mantenimiento",
      accountCode: over.accountCode ?? "514505",
      costCenterId: over.costCenterId ?? null,
      date: new Date(`${over.day ?? "2026-10-10"}T17:00:00Z`),
      retentions: over.retentions ?? [],
    },
    amounts: a,
  };
}

const run = () => generateJournalForMonth("r1", "2026-10", OCT, { now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  m.log = [];
  m.expenses.mockResolvedValue([]);
  m.expensePays.mockResolvedValue([]);
});

describe("asiento de gastos con impuestos", () => {
  it("sin impuestos: D gasto · C 233505 por el valor (igual que antes)", async () => {
    const { row } = expenseRow({ subtotal: 500_000 });
    m.expenses.mockResolvedValue([row]);
    await run();
    expect(lines("expense")).toEqual([
      expect.objectContaining({ accountCode: "514505", debitCents: 500_000 }),
      expect.objectContaining({ accountCode: "233505", creditCents: 500_000 }),
    ]);
    expectBalanced();
  });

  it("gasto viejo (sin campos de impuestos, como lo dejaba la versión anterior) no cambia", async () => {
    m.expenses.mockResolvedValue([
      { amountCents: 300_000, category: "Arriendo", accountCode: "512010", costCenterId: null, date: new Date("2026-10-05T17:00:00Z") },
    ]);
    await run();
    expect(lines("expense")).toEqual([
      expect.objectContaining({ accountCode: "512010", debitCents: 300_000 }),
      expect.objectContaining({ accountCode: "233505", creditCents: 300_000 }),
    ]);
    expectBalanced();
  });

  it("IVA DESCONTABLE: D gasto por la base · D 24081001 el IVA · C 233505 base + IVA", async () => {
    const { row, amounts } = expenseRow({ subtotal: 1_000_000, ivaPct: 19, ivaDeductible: true });
    m.expenses.mockResolvedValue([row]);
    await run();
    expect(amounts).toMatchObject({ ivaCents: 190_000, costCents: 1_000_000, payableCents: 1_190_000 });
    expect(net("expense", "514505")).toBe(1_000_000);
    expect(net("expense", "24081001")).toBe(190_000);
    expect(net("expense", "233505")).toBe(-1_190_000);
    expectBalanced();
  });

  it("IVA NO descontable (comercio de INC): el IVA es mayor valor del gasto, nada a 2408", async () => {
    const { row } = expenseRow({ subtotal: 1_000_000, ivaPct: 19, ivaDeductible: false });
    m.expenses.mockResolvedValue([row]);
    await run();
    expect(net("expense", "514505")).toBe(1_190_000);
    expect(net("expense", "24081001")).toBe(0);
    expect(net("expense", "233505")).toBe(-1_190_000);
    expectBalanced();
  });

  it("INC siempre es costo: D gasto base + INC · C 233505 base + INC", async () => {
    const { row } = expenseRow({ subtotal: 200_000, inc: 16_000, ivaDeductible: true, category: "Representación", accountCode: "519505" });
    m.expenses.mockResolvedValue([row]);
    await run();
    expect(net("expense", "519505")).toBe(216_000);
    expect(net("expense", "24081001")).toBe(0);
    expect(net("expense", "233505")).toBe(-216_000);
    expectBalanced();
  });

  it("retenciones: C cada una a la cuenta de su concepto y C 233505 por el total a pagar", async () => {
    const retentions = [
      { kind: "retefuente", accountCode: "236515", amountCents: 110_000 }, // honorarios 11 %
      { kind: "reteiva", accountCode: "236705", amountCents: 28_500 },
      { kind: "reteica", accountCode: "236805", amountCents: 9_660 },
    ];
    const { row, amounts } = expenseRow({
      subtotal: 1_000_000,
      ivaPct: 19,
      ivaDeductible: true,
      retentions,
      category: "Honorarios contador",
      accountCode: "511005",
    });
    m.expenses.mockResolvedValue([row]);
    await run();
    expect(amounts.payableCents).toBe(1_000_000 + 190_000 - 110_000 - 28_500 - 9_660);
    expect(net("expense", "511005")).toBe(1_000_000);
    expect(net("expense", "24081001")).toBe(190_000);
    expect(net("expense", "236515")).toBe(-110_000);
    expect(net("expense", "236705")).toBe(-28_500);
    expect(net("expense", "236805")).toBe(-9_660);
    expect(net("expense", "233505")).toBe(-amounts.payableCents);
    expectBalanced();
  });

  it("una retención sin cuenta guardada cae en la del motor por tipo (2365/2367/2368)", async () => {
    const { row } = expenseRow({ subtotal: 400_000, retentions: [{ kind: "reteica", accountCode: "", amountCents: 2_800 }] });
    m.expenses.mockResolvedValue([row]);
    await run();
    expect(net("expense", "236805")).toBe(-2_800);
    expectBalanced();
  });

  it("varios gastos del día se agrupan por cuenta y centro; las retenciones por cuenta", async () => {
    const a = expenseRow({ subtotal: 100_000, ivaPct: 19, ivaDeductible: true, retentions: [{ kind: "retefuente", accountCode: "236505", amountCents: 4_000 }] });
    const b = expenseRow({ subtotal: 50_000, ivaPct: 5, ivaDeductible: true, retentions: [{ kind: "retefuente", accountCode: "236505", amountCents: 2_000 }], costCenterId: "cc-bar" });
    const c = expenseRow({ subtotal: 30_000, day: "2026-10-11" });
    m.expenses.mockResolvedValue([a.row, b.row, c.row]);
    await run();
    const expenseEntries = bySource("expense");
    expect(expenseEntries).toHaveLength(2);
    const first = expenseEntries[0]!.lines.create;
    expect(first.filter((l) => l.accountCode === "514505")).toHaveLength(2); // sin centro y con «cc-bar»
    expect(first.find((l) => l.accountCode === "236505")).toMatchObject({ creditCents: 6_000 });
    expect(first.find((l) => l.accountCode === "233505")).toMatchObject({
      creditCents: a.amounts.payableCents + b.amounts.payableCents,
    });
    expectBalanced();
  });
});

describe("pagos de gastos con impuestos", () => {
  it("pagado de contado: el abono por el TOTAL A PAGAR deja 233505 en cero (lo retenido queda en 2365)", async () => {
    const { row, amounts } = expenseRow({
      subtotal: 1_000_000,
      ivaPct: 19,
      ivaDeductible: true,
      retentions: [{ kind: "retefuente", accountCode: "236505", amountCents: 40_000 }],
    });
    m.expenses.mockResolvedValue([row]);
    m.expensePays.mockResolvedValue([{ amountCents: amounts.payableCents, accountCode: "111005", paidAt: new Date("2026-10-10T17:00:00Z") }]);
    await run();
    expect(net("expense", "233505") + net("expense_payment", "233505")).toBe(0);
    expect(net("expense_payment", "111005")).toBe(-amounts.payableCents);
    expect(net("expense", "236505")).toBe(-40_000);
    expectBalanced();
  });

  it("debiéndose con un abono parcial: queda en 233505 el saldo del total a pagar", async () => {
    const { row, amounts } = expenseRow({
      subtotal: 2_000_000,
      ivaPct: 19,
      ivaDeductible: false,
      retentions: [{ kind: "retefuente", accountCode: "236505", amountCents: 80_000 }],
    });
    m.expenses.mockResolvedValue([row]);
    m.expensePays.mockResolvedValue([{ amountCents: 1_000_000, accountCode: "110505", paidAt: new Date("2026-10-20T15:00:00Z") }]);
    await run();
    expect(-(net("expense", "233505") + net("expense_payment", "233505"))).toBe(amounts.payableCents - 1_000_000);
    expect(net("expense", "514505")).toBe(2_380_000);
    expectBalanced();
  });
});
