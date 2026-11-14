// «Ventas del día» con LÍNEAS LIBRES (servicios, alquileres, cargos sueltos)
// que suman su IVA/INC encima del precio: la base queda en ingresos (4135) y
// el impuesto va al generado de su tipo y tarifa —241205 el INC, el auxiliar
// de 2408 por tarifa el IVA—, como los platos del menú. Antes ese impuesto
// caía en 4135, la cuenta que cuadra el asiento.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ orders: vi.fn(), createEntry: vi.fn(), deleteMany: vi.fn() }));
// Notas crédito de proveedores (bloque 9): este test no las ejercita.
vi.mock("./supplierCreditNotePosting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supplierCreditNotePosting")>()),
  loadSupplierCreditFacts: async () => ({ notes: [], voids: [], applies: [], refunds: [] }),
  firstSupplierCreditActivity: async () => null,
}));
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
      fn({ journalEntry: { deleteMany: m.deleteMany, create: m.createEntry } }),
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
      ["110505", "413505", "241205", "24080501", "24080503", "238030"].map((c) => [
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
import type { FreeLine } from "./salesTaxSlices";

type Line = { accountCode: string; debitCents: number; creditCents: number };
type Created = { source: string; date: Date; memo: string; lines: { create: Line[] } };

const RANGE = { from: new Date("2026-09-01"), to: new Date("2026-10-01") };

/** Cuenta pagada en efectivo el 10-sep (+ propina y descuento opcionales). */
function order(opts: {
  subtotalCents: number;
  onTopCents: number;
  invoiceSnapshot: Record<string, unknown> | null;
  freeLines: FreeLine[];
  tipCents?: number;
  discountCents?: number;
}) {
  const tip = opts.tipCents ?? 0;
  return {
    paidAt: new Date("2026-09-10T18:00:00Z"),
    status: "paid",
    subtotalCents: opts.subtotalCents,
    tipCents: tip,
    invoiceSnapshot: opts.invoiceSnapshot,
    freeLines: opts.freeLines,
    payments: [{ method: "cash", amountCents: opts.subtotalCents + opts.onTopCents - (opts.discountCents ?? 0) + tip }],
  };
}

/** Bandeja (carta, INC 8 % embebido) + alquiler IVA 19 % + 2 meseros con INC 8 % encima. */
const FREE: FreeLine[] = [
  { amountCents: 10_000_000, taxKind: "iva", taxPct: 19 },
  { amountCents: 2_500_000, taxKind: "inc", taxPct: 8 },
];
const INVOICE = {
  items: [
    { qty: 1, name: "Bandeja", priceCents: 3_000_000, menuItemId: "m1", taxKind: null, taxPct: null },
    { qty: 1, name: "Alquiler", priceCents: 10_000_000, menuItemId: null, taxKind: "iva", taxPct: 19 },
    { qty: 2, name: "Meseros", priceCents: 1_250_000, menuItemId: null, taxKind: "inc", taxPct: 8 },
  ],
  subtotalCents: 15_500_000,
  taxCents: 2_100_000,
  taxByKind: { inc: 200_000, iva: 1_900_000 },
  salesTaxKind: "inc",
  salesTaxPct: 8,
  embeddedTaxCents: 222_222,
  embeddedBaseCents: 2_777_778,
};

async function generate(): Promise<Created[]> {
  await generateJournalForMonth("r", "2026-09", RANGE);
  return m.createEntry.mock.calls.map((c) => (c[0] as { data: Created }).data);
}
async function saleLines(): Promise<Map<string, number>> {
  const sale = (await generate()).filter((e) => e.source === "sale");
  expect(sale).toHaveLength(1);
  const lines = sale[0]!.lines.create;
  // Débitos = créditos.
  expect(lines.reduce((s, l) => s + l.debitCents - l.creditCents, 0)).toBe(0);
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.accountCode, (out.get(l.accountCode) ?? 0) + l.debitCents - l.creditCents);
  return out;
}

beforeEach(() => vi.clearAllMocks());

describe("asiento de ventas — líneas libres con impuesto encima", () => {
  it("facturada: base al ingreso, IVA 19 % al 24080501 y el INC encima junto al embebido en 241205", async () => {
    m.orders.mockResolvedValue([
      order({ subtotalCents: 15_500_000, onTopCents: 2_100_000, invoiceSnapshot: INVOICE, freeLines: FREE }),
    ]);
    const net = await saleLines();
    expect(net.get("110505")).toBe(17_600_000);
    expect(net.get("241205")).toBe(-(222_222 + 200_000));
    expect(net.get("24080501")).toBe(-1_900_000);
    // 2.777.778 de la bandeja + 10.000.000 del alquiler + 2.500.000 de los meseros.
    expect(net.get("413505")).toBe(-15_277_778);
  });

  it("sin factura: el impuesto encima de las líneas y el INC embebido sólo sobre la carta", async () => {
    m.orders.mockResolvedValue([
      order({ subtotalCents: 15_500_000, onTopCents: 2_100_000, invoiceSnapshot: null, freeLines: FREE }),
    ]);
    const net = await saleLines();
    expect(net.get("110505")).toBe(17_600_000);
    // round(3.000.000 × 8/108) = 222.222 (antes: sobre 15.500.000 = 1.148.148).
    expect(net.get("241205")).toBe(-(222_222 + 200_000));
    expect(net.get("24080501")).toBe(-1_900_000);
    expect(net.get("413505")).toBe(-15_277_778);
  });

  it("IVA 5 % encima va a su auxiliar; propina y descuento no tocan el impuesto", async () => {
    const free: FreeLine[] = [{ amountCents: 2_000_000, taxKind: "iva", taxPct: 5 }];
    m.orders.mockResolvedValue([
      order({
        subtotalCents: 3_080_000,
        onTopCents: 100_000,
        invoiceSnapshot: null,
        freeLines: free,
        tipCents: 300_000,
        discountCents: 308_000,
      }),
    ]);
    const net = await saleLines();
    expect(net.get("110505")).toBe(3_080_000 + 100_000 - 308_000 + 300_000);
    expect(net.get("24080503")).toBe(-100_000);
    expect(net.get("241205")).toBe(-80_000); // 1.080.000 × 8/108
    expect(net.get("238030")).toBe(-300_000);
    // Ingreso = bases − descuento (el descuento lo absorbe el ingreso, como siempre).
    expect(net.get("413505")).toBe(-(1_000_000 + 2_000_000 - 308_000));
  });

  it("varias cuentas el mismo día: un crédito por código, Σ de lo que cada una declaró", async () => {
    m.orders.mockResolvedValue([
      order({ subtotalCents: 15_500_000, onTopCents: 2_100_000, invoiceSnapshot: INVOICE, freeLines: FREE }),
      order({ subtotalCents: 1_000_000, onTopCents: 190_000, invoiceSnapshot: null, freeLines: [{ amountCents: 1_000_000, taxKind: "iva", taxPct: 19 }] }),
    ]);
    const net = await saleLines();
    expect(net.get("24080501")).toBe(-(1_900_000 + 190_000));
    expect(net.get("241205")).toBe(-422_222);
  });

  it("una cuenta sólo de carta queda exactamente como antes", async () => {
    m.orders.mockResolvedValue([
      order({
        subtotalCents: 3_000_000,
        onTopCents: 0,
        invoiceSnapshot: { ...INVOICE, items: [INVOICE.items[0]], subtotalCents: 3_000_000, taxCents: 0, taxByKind: { inc: 0, iva: 0 } },
        freeLines: [],
      }),
    ]);
    const net = await saleLines();
    expect([...net.entries()]).toEqual([
      ["110505", 3_000_000],
      ["413505", -2_777_778],
      ["241205", -222_222],
    ]);
  });

  it("regenerar es idempotente: borra los asientos del mes de la fuente y crea los mismos", async () => {
    m.orders.mockResolvedValue([
      order({ subtotalCents: 15_500_000, onTopCents: 2_100_000, invoiceSnapshot: INVOICE, freeLines: FREE }),
    ]);
    const first = await generate();
    m.createEntry.mockClear();
    const second = await generate();
    expect(second).toEqual(first);
    expect(m.deleteMany).toHaveBeenCalledWith({ where: { restaurantId: "r", source: "sale", sourceRef: "2026-09" } });
    expect(first[0]!.date).toEqual(new Date("2026-09-10T05:00:00.000Z"));
  });
});
