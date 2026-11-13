// El motor asienta por DÍA DE NEGOCIO (Bogotá con la hora de corte del
// comercio), no por mes: un asiento por fuente y día, fechado a la
// medianoche de Bogotá del día. Invariantes:
//  · un pedido pagado a las 23:30 de Bogotá y otro a las 02:00 del día
//    siguiente caen en el MISMO día de negocio; uno a las 05:30 ya es el
//    siguiente (corte 5);
//  · Σ días == mes: la suma de los asientos del día, por cuenta y fuente,
//    es exactamente la agregación del mes de negocio completo;
//  · las guardas (ingreso negativo, proveedores negativo) omiten SÓLO el día;
//  · los campos FECHA (gastos) van por día calendario, los timestamps por
//    día de negocio; nómina/depreciación/diferidos siguen mensuales;
//  · por fuente: borrar (fuente, mes) y crear los N del día en la misma
//    transacción, sin tocar manuales, numerados ni anulados.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SalesPostingOrder } from "./accountingData";

const m = vi.hoisted(() => ({
  cutoff: 5,
  orders: vi.fn(),
  purchases: vi.fn(),
  stock: vi.fn(),
  expenses: vi.fn(),
  expensePays: vi.fn(),
  purchasePays: vi.fn(),
  creditPays: vi.fn(),
  refunds: vi.fn(),
  /** Lo que pasó por la transacción, en orden. */
  log: [] as Array<{ op: "delete" | "create" | "notes"; args: Record<string, unknown> }>,
  txCount: 0,
}));
// Notas crédito de proveedores (bloque 9): este test no las ejercita.
vi.mock("./supplierCreditNotePosting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supplierCreditNotePosting")>()),
  loadSupplierCreditFacts: async () => ({ notes: [], voids: [], applies: [], refunds: [] }),
  firstSupplierCreditActivity: async () => null,
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: {
      findUnique: async () => ({ businessDayCutoffHour: m.cutoff, salesTaxKind: "inc", salesTaxPct: 8 }),
    },
    stockMovement: { findMany: m.stock },
    expense: { findMany: m.expenses },
    expensePayment: { findMany: m.expensePays },
    purchasePayment: { findMany: m.purchasePays },
    customerCreditPayment: { findMany: m.creditPays },
    deferredItem: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => unknown) => {
      m.txCount++;
      return fn({
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
        creditNote: {
          updateMany: async (args: Record<string, unknown>) => {
            m.log.push({ op: "notes", args });
            return { count: 0 };
          },
        },
      });
    },
  },
}));
vi.mock("./accountingData", () => ({
  loadSalesPostingOrders: m.orders,
  loadPurchasesBook: m.purchases,
  computeMonthLabor: async () => null,
}));
vi.mock("./ledger", () => ({
  ensureChartOfAccounts: vi.fn(),
  loadAccountIndex: async () =>
    new Map(
      [
        "110505", "111005", "112005", "130505", "143505", "220505", "233505", "236505", "238020", "238030",
        "241205", "24080501", "24081001", "413505", "417505", "512010", "519505", "613505",
      ].map((c) => [c, { id: `id-${c}`, postable: true, active: true }]),
    ),
}));
vi.mock("./activos", () => ({ depreciationLinesForMonth: async () => [] }));
vi.mock("./deferred", () => ({ deferredAmortizationLinesForMonth: async () => [] }));
vi.mock("./payrollData", () => ({ payrollTotalsForPosting: async () => null }));
vi.mock("./creditNoteAccounting", () => ({
  loadCreditNoteMonthPosting: async () => ({ notes: [], noteIds: [] }),
  loadRefundMonthPosting: m.refunds,
}));

import { generateJournalForMonth } from "./posting";

type Line = { accountCode: string; debitCents: number; creditCents: number };
type Created = { source: string; memo: string; sourceRef: string; date: Date; lines: { create: Line[] } };

const OCT = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
/** Octubre ya terminó cuando corre el motor. */
const NOW = new Date("2026-11-15T10:30:00Z");

/** Instante de Bogotá ("2026-10-17 23:30") en UTC. */
const bog = (local: string) => new Date(`${local.replace(" ", "T")}:00.000-05:00`);

/** Pedido pagado en efectivo, con INC 8 % congelado en su factura. */
function order(paidAt: Date, grossCents: number, over: Partial<SalesPostingOrder> = {}): SalesPostingOrder {
  const taxCents = Math.round((grossCents * 8) / 108);
  return {
    paidAt,
    status: "paid",
    subtotalCents: grossCents,
    tipCents: 0,
    invoiceSnapshot: {
      subtotalCents: grossCents,
      salesTaxKind: "inc",
      salesTaxPct: 8,
      embeddedTaxCents: taxCents,
      embeddedBaseCents: grossCents - taxCents,
    } as SalesPostingOrder["invoiceSnapshot"],
    freeLines: [],
    payments: [{ method: "cash", amountCents: grossCents }],
    ...over,
  };
}

const created = () => m.log.filter((l) => l.op === "create").map((l) => l.args as unknown as Created);
const bySource = (source: string) => created().filter((e) => e.source === source);
const isoDates = (list: Created[]) => list.map((e) => e.date.toISOString());
/** Saldo neto (D − C) por cuenta sobre un conjunto de asientos. */
function netByAccount(list: Created[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of list) for (const l of e.lines.create) out.set(l.accountCode, (out.get(l.accountCode) ?? 0) + l.debitCents - l.creditCents);
  return out;
}

async function run(month = "2026-10", range = OCT) {
  return generateJournalForMonth("r1", month, range, { now: NOW });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.cutoff = 5;
  m.log = [];
  m.txCount = 0;
  m.orders.mockResolvedValue([]);
  m.purchases.mockResolvedValue({ rows: [], totals: {} });
  m.stock.mockResolvedValue([]);
  m.expenses.mockResolvedValue([]);
  m.expensePays.mockResolvedValue([]);
  m.purchasePays.mockResolvedValue([]);
  m.creditPays.mockResolvedValue([]);
  m.refunds.mockResolvedValue({ refunds: [], totalCents: 0, liabilityCents: 0 });
});

describe("día de negocio de las ventas (corte 05:00 Bogotá)", () => {
  it("la cena de las 23:30 y el cobro de las 02:00 caen en el mismo día; el de las 05:30 ya es el siguiente", async () => {
    m.orders.mockResolvedValue([
      order(bog("2026-10-17 23:30"), 108_000),
      order(bog("2026-10-18 02:00"), 54_000),
      order(bog("2026-10-18 05:30"), 27_000),
    ]);
    await run();
    const sales = bySource("sale");
    expect(isoDates(sales)).toEqual(["2026-10-17T05:00:00.000Z", "2026-10-18T05:00:00.000Z"]);
    expect(sales[0]!.memo).toBe("Ventas del día");
    expect(sales[0]!.sourceRef).toBe("2026-10");
    expect(sales[0]!.lines.create).toEqual([
      expect.objectContaining({ accountCode: "110505", debitCents: 162_000 }),
      expect.objectContaining({ accountCode: "413505", creditCents: 150_000 }),
      expect.objectContaining({ accountCode: "241205", creditCents: 12_000 }),
    ]);
    expect(sales[1]!.lines.create).toEqual([
      expect.objectContaining({ accountCode: "110505", debitCents: 27_000 }),
      expect.objectContaining({ accountCode: "413505", creditCents: 25_000 }),
      expect.objectContaining({ accountCode: "241205", creditCents: 2_000 }),
    ]);
  });

  it("el mes de negocio: los hechos se cargan del comienzo del día 1 al final del último día (no el mes UTC)", async () => {
    await run();
    const range = m.orders.mock.calls[0]![1] as { from: Date; to: Date };
    expect(range).toEqual({ from: new Date("2026-10-01T10:00:00.000Z"), to: new Date("2026-11-01T10:00:00.000Z") });
    expect(m.purchases.mock.calls[0]![1]).toEqual(range);
    expect(m.refunds.mock.calls[0]![1]).toEqual(range);
    expect(m.stock.mock.calls[0]![0].where.createdAt).toEqual({ gte: range.from, lt: range.to });
    expect(m.purchasePays.mock.calls[0]![0].where.paidAt).toEqual({ gte: range.from, lt: range.to });
    // Los gastos (FECHA contable) siguen con el mes calendario UTC.
    expect(m.expenses.mock.calls[0]![0].where.date).toEqual({ gte: OCT.from, lt: OCT.to });
  });

  it("sin corte (0), el día cambia a la medianoche de Bogotá", async () => {
    m.cutoff = 0;
    m.orders.mockResolvedValue([order(bog("2026-10-17 23:30"), 108_000), order(bog("2026-10-18 00:30"), 54_000)]);
    await run();
    expect(isoDates(bySource("sale"))).toEqual(["2026-10-17T05:00:00.000Z", "2026-10-18T05:00:00.000Z"]);
  });

  it("los cobros, la propina y el impuesto de un pedido van al día de su `paidAt`", async () => {
    m.orders.mockResolvedValue([
      order(bog("2026-10-17 21:00"), 108_000, {
        tipCents: 10_000,
        payments: [{ method: "cash", amountCents: 100_000 }, { method: "kushki_card", amountCents: 18_000 }],
      }),
    ]);
    await run();
    const sale = bySource("sale")[0]!;
    expect(sale.lines.create).toEqual([
      expect.objectContaining({ accountCode: "110505", debitCents: 100_000 }),
      expect.objectContaining({ accountCode: "112005", debitCents: 18_000 }),
      expect.objectContaining({ accountCode: "413505", creditCents: 100_000 }),
      expect.objectContaining({ accountCode: "241205", creditCents: 8_000 }),
      expect.objectContaining({ accountCode: "238030", creditCents: 10_000 }),
    ]);
  });
});

describe("Σ días == mes", () => {
  it("la suma por cuenta de los asientos del día es la del mes de negocio completo, fuente por fuente", async () => {
    const days = ["2026-10-01 12:00", "2026-10-01 23:59", "2026-10-02 01:30", "2026-10-15 20:00", "2026-10-31 23:00", "2026-11-01 04:59"];
    const orders = days.map((d, i) => order(bog(d), 108_000 * (i + 1), { tipCents: 1_000 * i }));
    m.orders.mockResolvedValue(orders);
    const rows = days.map((d, i) => ({
      receivedAt: bog(d), receivedCents: 10_000 * (i + 1), incCents: 0, nonInventoryReceivedCents: 1_000, nonInventoryIncCents: 0,
      nonInventoryNonDeductibleTaxCents: 0, ivaCents: 1_900 * (i + 1), retefuenteCents: 100, reteIvaCents: 0, reteIcaCents: 0,
    }));
    m.purchases.mockResolvedValue({ rows, totals: {} });
    m.stock.mockResolvedValue(days.flatMap((d, i) => [
      { kind: "sale_consumption", valueCents: -3_333 * (i + 1), createdAt: bog(d) },
      { kind: "waste", valueCents: -111 * (i + 1), createdAt: bog(d) },
    ]));
    m.purchasePays.mockResolvedValue(days.map((d, i) => ({ amountCents: 5_000 + i, accountCode: "111005", method: null, paidAt: bog(d) })));
    m.creditPays.mockResolvedValue(days.map((d, i) => ({ amountCents: 700 + i, accountCode: "110505", paidAt: bog(d) })));
    m.expensePays.mockResolvedValue(days.map((d, i) => ({ amountCents: 900 + i, accountCode: "110505", paidAt: bog(d) })));
    m.expenses.mockResolvedValue(days.map((d, i) => ({ amountCents: 2_000 + i, category: "Arriendo", accountCode: "512010", costCenterId: null, date: new Date(`2026-10-${String(1 + i * 5).padStart(2, "0")}T17:00:00Z`) })));
    m.refunds.mockResolvedValue({
      refunds: days.map((d, i) => ({ id: `k${i}`, createdAt: bog(d), amountCents: 10_800 + 108 * i, liabilityCents: i % 2 ? 5_000 : 0 })),
      totalCents: 0,
      liabilityCents: 0,
    });
    const results = await run();

    // Los 6 instantes caen en 3 días de negocio: 1, 1 (23:59), 1 (2-oct 01:30),
    // 15, 31 y 31 (1-nov 04:59).
    const sales = bySource("sale");
    expect(isoDates(sales)).toEqual(["2026-10-01T05:00:00.000Z", "2026-10-15T05:00:00.000Z", "2026-10-31T05:00:00.000Z"]);

    // Σ días == mes por cuenta y fuente: lo que daría la agregación completa.
    const gross = orders.reduce((s, o) => s + o.subtotalCents, 0);
    const tax = orders.reduce((s, o) => s + o.invoiceSnapshot!.embeddedTaxCents!, 0);
    const tips = orders.reduce((s, o) => s + o.tipCents, 0);
    const saleNet = netByAccount(sales);
    expect(saleNet.get("110505")).toBe(gross);
    expect(saleNet.get("413505")).toBe(-(gross - tax - tips));
    expect(saleNet.get("241205")).toBe(-tax);
    expect(saleNet.get("238030")).toBe(-tips);

    const purchaseNet = netByAccount(bySource("purchase"));
    const received = rows.reduce((s, r) => s + r.receivedCents, 0);
    const iva = rows.reduce((s, r) => s + r.ivaCents, 0);
    expect(purchaseNet.get("143505")).toBe(received - rows.length * 1_000);
    expect(purchaseNet.get("519505")).toBe(rows.length * 1_000);
    expect(purchaseNet.get("24081001")).toBe(iva);
    expect(purchaseNet.get("236505")).toBe(-rows.length * 100);
    expect(purchaseNet.get("220505")).toBe(-(received + iva - rows.length * 100));

    const cogsNet = netByAccount(bySource("cogs"));
    expect(cogsNet.get("613505")).toBe(3_333 * 21);
    expect(cogsNet.get("143505")).toBe(-3_333 * 21);
    expect(netByAccount(bySource("waste")).get("519505")).toBe(111 * 21);

    expect(netByAccount(bySource("purchase_payment")).get("220505")).toBe(6 * 5_000 + 15);
    expect(netByAccount(bySource("customer_credit_payment")).get("130505")).toBe(-(6 * 700 + 15));
    expect(netByAccount(bySource("expense_payment")).get("233505")).toBe(6 * 900 + 15);
    expect(netByAccount(bySource("expense")).get("233505")).toBe(-(6 * 2_000 + 15));

    const refundNet = netByAccount(bySource("refund"));
    const refundTotal = 6 * 10_800 + 108 * 15;
    expect(refundNet.get("112005")).toBe(-refundTotal);
    expect(refundNet.get("238020")).toBe(3 * 5_000);

    // Cada asiento cuadra y el resultado por fuente es la suma de sus días.
    for (const e of created()) {
      const d = e.lines.create.reduce((s, l) => s + l.debitCents, 0);
      const c = e.lines.create.reduce((s, l) => s + l.creditCents, 0);
      expect(d).toBe(c);
    }
    expect(results).toContainEqual({ source: "sale", totalCents: gross });
    expect(results).toContainEqual({ source: "purchase_payment", totalCents: 6 * 5_000 + 15 });
    expect(results.map((r) => r.source)).toEqual([
      "sale", "customer_credit_payment", "purchase", "purchase_payment", "cogs", "waste", "expense", "expense_payment", "refund",
    ]);
  });

  it("un pedido del 1-nov a la 1 a. m. de Bogotá es del 31-oct; uno del 1-oct a las 4 a. m. es de septiembre (no entra)", async () => {
    m.orders.mockImplementation(async (_r: string, range: { from: Date; to: Date }) =>
      [order(bog("2026-10-01 04:00"), 108_000), order(bog("2026-11-01 01:00"), 54_000)].filter(
        (o) => o.paidAt >= range.from && o.paidAt < range.to,
      ),
    );
    await run();
    const sales = bySource("sale");
    expect(isoDates(sales)).toEqual(["2026-10-31T05:00:00.000Z"]);
    expect(netByAccount(sales).get("110505")).toBe(54_000);
  });
});

describe("guardas por día", () => {
  it("un día con ingreso negativo (cobros < impuesto + propinas) se omite solo; los demás se asientan", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.orders.mockResolvedValue([
      order(bog("2026-10-10 20:00"), 108_000),
      // Propina mayor que lo cobrado: datos inconsistentes.
      order(bog("2026-10-11 20:00"), 108_000, { tipCents: 200_000 }),
      order(bog("2026-10-12 20:00"), 54_000),
    ]);
    await run();
    expect(isoDates(bySource("sale"))).toEqual(["2026-10-10T05:00:00.000Z", "2026-10-12T05:00:00.000Z"]);
    expect(err).toHaveBeenCalledWith(
      "[posting] ventas con ingreso negativo — día omitido",
      expect.objectContaining({ restaurantId: "r1", day: "2026-10-11", totalCash: 108_000, tips: 200_000 }),
    );
    err.mockRestore();
  });

  it("un día con proveedores negativo (retenciones > compra) se omite solo", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const row = (receivedAt: Date, receivedCents: number, retefuenteCents: number) => ({
      receivedAt, receivedCents, incCents: 0, nonInventoryReceivedCents: 0, nonInventoryIncCents: 0,
      nonInventoryNonDeductibleTaxCents: 0, ivaCents: 0, retefuenteCents, reteIvaCents: 0, reteIcaCents: 0,
    });
    m.purchases.mockResolvedValue({
      rows: [row(bog("2026-10-05 10:00"), 100_000, 2_500), row(bog("2026-10-06 10:00"), 10_000, 50_000)],
      totals: {},
    });
    await run();
    expect(isoDates(bySource("purchase"))).toEqual(["2026-10-05T05:00:00.000Z"]);
    expect(err).toHaveBeenCalledWith(
      "[posting] compras con proveedores negativo — día omitido",
      expect.objectContaining({ day: "2026-10-06", ret: 50_000 }),
    );
    err.mockRestore();
  });

  it("un día con una cuenta no imputable se omite solo (y queda en el log con el día)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    m.expensePays.mockResolvedValue([
      { amountCents: 1_000, accountCode: "110505", paidAt: bog("2026-10-05 10:00") },
      { amountCents: 2_000, accountCode: "999999", paidAt: bog("2026-10-06 10:00") },
    ]);
    await run();
    expect(isoDates(bySource("expense_payment"))).toEqual(["2026-10-05T05:00:00.000Z"]);
    expect(err).toHaveBeenCalledWith(
      "[posting] cuenta no imputable",
      expect.objectContaining({ source: "expense_payment", day: "2026-10-06", code: "999999" }),
    );
    err.mockRestore();
  });
});

describe("costo de ventas y mermas por día", () => {
  it("las salidas (valor negativo) debitan costo/gasto y acreditan inventario, día por día", async () => {
    m.stock.mockResolvedValue([
      { kind: "sale_consumption", valueCents: -5_000, createdAt: bog("2026-10-10 20:00") },
      { kind: "sale_consumption", valueCents: -2_500, createdAt: bog("2026-10-11 01:00") },
      { kind: "sale_consumption", valueCents: -1_000, createdAt: bog("2026-10-11 12:00") },
      { kind: "waste", valueCents: -300, createdAt: bog("2026-10-11 12:00") },
    ]);
    await run();
    const cogs = bySource("cogs");
    expect(isoDates(cogs)).toEqual(["2026-10-10T05:00:00.000Z", "2026-10-11T05:00:00.000Z"]);
    expect(cogs[0]!.memo).toBe("Costo de ventas del día");
    expect(cogs[0]!.lines.create).toEqual([
      expect.objectContaining({ accountCode: "613505", debitCents: 7_500 }),
      expect.objectContaining({ accountCode: "143505", creditCents: 7_500 }),
    ]);
    expect(cogs[1]!.lines.create[0]).toEqual(expect.objectContaining({ accountCode: "613505", debitCents: 1_000 }));
    const waste = bySource("waste");
    expect(isoDates(waste)).toEqual(["2026-10-11T05:00:00.000Z"]);
    expect(waste[0]!.lines.create).toEqual([
      expect.objectContaining({ accountCode: "519505", debitCents: 300 }),
      expect.objectContaining({ accountCode: "143505", creditCents: 300 }),
    ]);
  });

  it("un día con más reversas que salidas se asienta al revés (D inventario · C costo), así Σ días sigue siendo el mes", async () => {
    m.stock.mockResolvedValue([
      { kind: "sale_consumption", valueCents: -5_000, createdAt: bog("2026-10-10 20:00") },
      { kind: "sale_consumption", valueCents: 2_000, createdAt: bog("2026-10-12 20:00") },
    ]);
    await run();
    const cogs = bySource("cogs");
    expect(cogs[1]!.lines.create).toEqual([
      expect.objectContaining({ accountCode: "143505", debitCents: 2_000 }),
      expect.objectContaining({ accountCode: "613505", creditCents: 2_000 }),
    ]);
    expect(netByAccount(cogs).get("613505")).toBe(3_000);
  });
});

describe("idempotencia y seguridad al persistir", () => {
  it("por fuente: una transacción que borra (fuente, mes) y crea los N del día, en ese orden", async () => {
    m.orders.mockResolvedValue([order(bog("2026-10-10 20:00"), 108_000), order(bog("2026-10-12 20:00"), 54_000)]);
    m.creditPays.mockResolvedValue([{ amountCents: 1_000, accountCode: "110505", paidAt: bog("2026-10-12 20:00") }]);
    await run();
    // 1 de huérfanos + 1 por fuente producida (sale, customer_credit_payment).
    expect(m.txCount).toBe(3);
    const ops = m.log.map((l) => [l.op, (l.args as { source?: string | { in: string[] } }).source]);
    expect(ops[0]![0]).toBe("delete"); // huérfanos
    expect(ops.slice(1)).toEqual([
      ["delete", "sale"],
      ["create", "sale"],
      ["create", "sale"],
      ["delete", "customer_credit_payment"],
      ["create", "customer_credit_payment"],
    ]);
    // El borrado de la fuente es por (fuente, sourceRef = mes): nunca toca
    // manuales (otra fuente) y, los huérfanos, nunca numerados ni anulados.
    expect(m.log[1]!.args).toEqual({ restaurantId: "r1", source: "sale", sourceRef: "2026-10" });
    expect(m.log[0]!.args).toEqual({
      restaurantId: "r1",
      sourceRef: "2026-10",
      source: { in: expect.not.arrayContaining(["sale", "customer_credit_payment", "manual"]) },
      voucherNumber: null,
      annulledAt: null,
    });
    // Todos los asientos del motor llevan sourceRef = mes.
    for (const e of created()) expect(e.sourceRef).toBe("2026-10");
  });

  it("sin hechos en el mes no crea nada y sólo borra los huérfanos", async () => {
    const results = await run();
    expect(results).toEqual([]);
    expect(created()).toEqual([]);
    expect(m.log).toHaveLength(1);
    expect(m.log[0]!.op).toBe("delete");
  });

  it("un mes inválido no arma nada", async () => {
    expect(await run("2026-13", OCT)).toEqual([]);
    expect(created()).toEqual([]);
  });
});
