// PYG del mes: «Ingresos por ventas» ya no es Σ subtotal (con impuesto,
// antes de descuentos y sin notas): es lo cobrado sin impuesto ni propina,
// neto de descuentos, menos notas crédito aceptadas y devoluciones. El
// impuesto que resta es el mismo de la tarjeta de impuestos.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  orderAggregate: vi.fn(),
  items: vi.fn(),
  invoices: vi.fn(),
  creditNotes: vi.fn(),
  refunds: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: {
      findUnique: async () => ({
        enabledModules: [],
        country: "CO",
        salesTaxKind: "inc",
        salesTaxPct: 8,
        staffStrictAttendance: false,
        staffHolidayPct: 0,
        staffSundayPct: 0,
        staffHoursDivisor: 240,
      }),
    },
    order: { aggregate: m.orderAggregate },
    orderItem: { findMany: m.items },
    simpleInvoice: { findMany: m.invoices },
    stockMovement: { groupBy: async () => [] },
    expense: { groupBy: async () => [] },
    purchaseOrder: { findMany: async () => [] },
    creditNote: {
      findMany: (args: { where: { accountingStampedAt?: unknown } }) =>
        "accountingStampedAt" in args.where ? Promise.resolve([]) : m.creditNotes(args),
    },
    kushkiTransaction: { findMany: m.refunds },
  },
}));

import { computeMonthPnl } from "./accountingData";

const RANGE = { from: new Date("2026-09-01T00:00:00.000Z"), to: new Date("2026-10-01T00:00:00.000Z") };

beforeEach(() => {
  vi.resetAllMocks();
  // Dos cuentas del mes: $108.000 de carta con INC 8 % congelado, una con
  // descuento de $10.800, y $5.000 de propina.
  m.orderAggregate.mockImplementation(async (args: { where: object; _sum: Record<string, boolean> }) =>
    args._sum.discountCents
      ? { _sum: { subtotalCents: 108_000, discountCents: 10_800, tipCents: 5_000, taxCents: 0 } }
      : { _sum: { subtotalCents: "simpleInvoice" in args.where ? 0 : 108_000 } },
  );
  m.invoices.mockResolvedValue([
    { snapshot: { subtotalCents: 108_000, salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 8_000, embeddedBaseCents: 100_000 } },
  ]);
  m.items.mockResolvedValue([
    { qty: 1, priceCentsSnapshot: 75_600, menuItemId: "m1", taxKind: null, cancelledAt: null, cancellationKind: null, menuItem: { category: { label: "Platos" } } },
    { qty: 1, priceCentsSnapshot: 32_400, menuItemId: "m2", taxKind: null, cancelledAt: null, cancellationKind: null, menuItem: { category: { label: "Bebidas" } } },
  ]);
  m.creditNotes.mockResolvedValue([]);
  m.refunds.mockResolvedValue([]);
});

describe("computeMonthPnl — ingresos por ventas netos", () => {
  it("sin impuesto ni propina y neto del descuento; las categorías suman lo mismo", async () => {
    const pnl = await computeMonthPnl("r1", RANGE);
    expect(pnl.salesDetail).toEqual({
      listCents: 108_000,
      discountCents: 10_800,
      includedTaxCents: 8_000,
      creditNotesCents: 0,
      refundsCents: 0,
    });
    expect(pnl.salesCents).toBe(108_000 - 10_800 - 8_000);
    expect(pnl.tipsCents).toBe(5_000);
    const byCategory = pnl.categoryBreakdown.reduce((s, c) => s + c.salesCents, 0);
    expect(byCategory).toBe(pnl.salesCents);
    expect(pnl.categoryBreakdown.map((c) => c.category)).toEqual(["Platos", "Bebidas"]);
  });

  it("resta la base de las notas crédito aceptadas del mes y de las devoluciones sin nota", async () => {
    const at = new Date("2026-09-20T15:00:00Z");
    m.creditNotes.mockResolvedValue([
      {
        id: "n1",
        documentNumber: "NC1",
        subtotalCents: 20_000,
        taxCents: 1_600,
        totalCents: 21_600,
        createdAt: at,
        dianDocument: { issuedAt: at },
        snapshot: {
          original: { invoiceNumber: "FE1" },
          lines: [{ lineTotalCents: 20_000, taxCents: 1_600, grossCents: 21_600, taxPct: "8.00", taxSchemeId: "04" }],
        },
      },
    ]);
    m.refunds.mockResolvedValue([{ id: "k1", amountCents: 10_800, payment: null }]);
    const pnl = await computeMonthPnl("r1", RANGE);
    expect(pnl.salesDetail).toMatchObject({ creditNotesCents: 20_000, refundsCents: 10_000 });
    expect(pnl.salesCents).toBe(108_000 - 10_800 - 8_000 - 20_000 - 10_000);
    // Las categorías no cargan notas ni devoluciones (no tienen categoría).
    const byCategory = pnl.categoryBreakdown.reduce((s, c) => s + c.salesCents, 0);
    expect(byCategory).toBe(108_000 - 10_800 - 8_000);
  });
});
