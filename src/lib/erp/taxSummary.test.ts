// El impuesto de ventas del mes sale de lo FACTURADO (la tarifa que cada
// tirilla congeló), no de "tarifa de hoy × ventas del mes". Prender el
// impoconsumo hoy no puede recalcular septiembre.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  restaurant: vi.fn(),
  orderAggregate: vi.fn(),
  invoices: vi.fn(),
  creditNotes: vi.fn(),
  refunds: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    order: { aggregate: m.orderAggregate },
    simpleInvoice: { findMany: m.invoices },
    purchaseOrder: { findMany: async () => [] },
    // Notas del mes (y la búsqueda de notas sin fijar, que acá no hay).
    creditNote: {
      findMany: (args: { where: { accountingStampedAt?: unknown } }) =>
        "accountingStampedAt" in args.where ? Promise.resolve([]) : m.creditNotes(args),
    },
    kushkiTransaction: { findMany: m.refunds },
  },
}));

import { computeTaxSummary } from "./accountingData";

const RANGE = { from: new Date("2026-09-01T05:00:00.000Z"), to: new Date("2026-10-01T05:00:00.000Z") };

/** Bandeja de $30.000 con INC 8% congelado (mismo reparto que el XML). */
const INC_8 = {
  snapshot: {
    subtotalCents: 3_000_000,
    salesTaxKind: "inc",
    salesTaxPct: 8,
    embeddedTaxCents: 222_222,
    embeddedBaseCents: 2_777_778,
  },
};
/** $10.000 con IVA 19% congelado. */
const IVA_19 = {
  snapshot: {
    subtotalCents: 1_000_000,
    salesTaxKind: "iva",
    salesTaxPct: 19,
    embeddedTaxCents: 159_664,
    embeddedBaseCents: 840_336,
  },
};
/** Emitida antes de que se congelara la tarifa: no tiene los campos. */
const OLD = { snapshot: { subtotalCents: 500_000 } };
/** Emitida con el comercio en "none", a propósito. */
const NONE = {
  snapshot: {
    subtotalCents: 700_000,
    salesTaxKind: "none",
    salesTaxPct: 0,
    embeddedTaxCents: 0,
    embeddedBaseCents: 700_000,
  },
};

/** Bruto del mes: `all` = todas las pagadas; `uninvoiced` = las sin factura. */
function sales(all: number, uninvoiced: number) {
  m.orderAggregate.mockImplementation(async (args: { where: { simpleInvoice?: unknown } }) => ({
    _sum: { subtotalCents: "simpleInvoice" in args.where ? uninvoiced : all },
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurant.mockResolvedValue({ salesTaxKind: "inc", salesTaxPct: 8 });
  m.invoices.mockResolvedValue([]);
  m.creditNotes.mockResolvedValue([]);
  m.refunds.mockResolvedValue([]);
  sales(0, 0);
});

/** Nota crédito aceptada de $10.800 (INC 8 %) emitida el 15-sep en Bogotá. */
function note(id: string, over: { issuedAt?: string; base?: number; tax?: number } = {}) {
  const base = over.base ?? 1_000_000;
  const tax = over.tax ?? 80_000;
  const at = new Date(over.issuedAt ?? "2026-09-15T15:00:00Z");
  return {
    id,
    documentNumber: `NC${id}`,
    subtotalCents: base,
    taxCents: tax,
    totalCents: base + tax,
    createdAt: at,
    dianDocument: { issuedAt: at },
    snapshot: {
      original: { invoiceNumber: "FE1" },
      lines: [{ lineTotalCents: base, taxCents: tax, grossCents: base + tax, taxPct: "8.00", taxSchemeId: "04" }],
    },
  };
}

describe("computeTaxSummary — ventas", () => {
  it("un mes que mezcla tarifas lleva un tramo por cada una, más lo viejo en cero", async () => {
    m.invoices.mockResolvedValue([INC_8, IVA_19, OLD, NONE]);
    sales(3_000_000 + 1_000_000 + 500_000 + 700_000, 0);
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    expect(s.byRate).toEqual([
      { kind: "inc", pct: 8, grossCents: 3_000_000, taxCents: 222_222, baseCents: 2_777_778 },
      { kind: "iva", pct: 19, grossCents: 1_000_000, taxCents: 159_664, baseCents: 840_336 },
    ]);
    expect(s.taxCents).toBe(222_222 + 159_664);
    expect(s.grossCents).toBe(5_200_000);
    expect(s.baseCents).toBe(5_200_000 - 381_886);
    // Etiqueta del mes: el tramo que más causó.
    expect(s.kind).toBe("inc");
    expect(s.pct).toBe(8);
  });

  it("prender INC hoy no toca lo emitido: facturas congeladas en 'none' suman cero", async () => {
    // Comercio en INC 8% desde hoy; las facturas del mes salieron sin
    // impuesto y así las aceptó la DIAN. Antes esto daba 8% × todo el mes.
    m.restaurant.mockResolvedValue({ salesTaxKind: "inc", salesTaxPct: 8 });
    m.invoices.mockResolvedValue([NONE, OLD]);
    sales(1_200_000, 0);
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    expect(s.byRate).toEqual([]);
    expect(s.taxCents).toBe(0);
    expect(s.baseCents).toBe(1_200_000);
    // Sin impuesto causado, el mes se etiqueta con la configuración actual
    // (así "none" sigue significando "sin impuesto configurado").
    expect(s.kind).toBe("inc");
    expect(s.pct).toBe(8);
  });

  it("apagar el impuesto tampoco: la factura que se emitió con 8% lo conserva", async () => {
    m.restaurant.mockResolvedValue({ salesTaxKind: "none", salesTaxPct: 0 });
    m.invoices.mockResolvedValue([INC_8]);
    sales(3_000_000, 0);
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    expect(s.byRate).toEqual([
      { kind: "inc", pct: 8, grossCents: 3_000_000, taxCents: 222_222, baseCents: 2_777_778 },
    ]);
    expect(s.kind).toBe("inc");
    expect(s.taxCents).toBe(222_222);
  });

  it("las ventas SIN factura siguen con la tarifa actual del comercio (no hay documento que las congele)", async () => {
    m.invoices.mockResolvedValue([INC_8]);
    sales(3_000_000 + 250_000, 250_000);
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    // 250.000 × 8/108 = 18.519, sumado al tramo INC 8% de las facturas.
    expect(s.byRate).toEqual([
      { kind: "inc", pct: 8, grossCents: 3_250_000, taxCents: 240_741, baseCents: 3_009_259 },
    ]);
    expect(s.taxCents).toBe(240_741);
  });

  it("sin ventas ni facturas: cero, etiquetado con la configuración actual", async () => {
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    expect(s).toEqual({
      kind: "inc",
      pct: 8,
      grossCents: 0,
      taxCents: 0,
      baseCents: 0,
      byRate: [],
      creditNotes: { count: 0, grossCents: 0, baseCents: 0, taxCents: 0 },
      refunds: { grossCents: 0, baseCents: 0, taxCents: 0 },
      net: { baseCents: 0, taxCents: 0, byRate: [] },
    });
  });

  it("corta el mes por la fecha de pago de la orden, como el libro de ventas", async () => {
    await computeTaxSummary("rest-1", RANGE);
    const paid = { status: "paid", paidAt: { gte: RANGE.from, lt: RANGE.to } };
    expect(m.invoices).toHaveBeenCalledWith({
      where: { restaurantId: "rest-1", order: paid },
      select: { snapshot: true },
    });
    expect(m.orderAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { restaurantId: "rest-1", ...paid, simpleInvoice: null } }),
    );
  });
});

describe("computeTaxSummary — notas crédito y devoluciones", () => {
  it("el bruto no cambia (lo asienta «Ventas del mes»); el neto resta las notas aceptadas del mes en su tarifa", async () => {
    m.invoices.mockResolvedValue([INC_8]);
    sales(3_000_000, 0);
    m.creditNotes.mockResolvedValue([
      note("1"),
      // 1-sep a las 2 a. m. UTC son las 9 p. m. del 31-ago en Bogotá: agosto, fuera.
      note("4", { issuedAt: "2026-09-01T02:00:00Z" }),
      // 2-sep: dentro.
      note("2", { issuedAt: "2026-09-02T15:00:00Z", base: 100_000, tax: 8_000 }),
      // Agosto en Bogotá: no resta acá.
      note("3", { issuedAt: "2026-08-31T15:00:00Z" }),
    ]);
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    expect(s.taxCents).toBe(222_222);
    expect(s.byRate[0]!.taxCents).toBe(222_222);
    expect(s.creditNotes).toEqual({ count: 2, grossCents: 1_188_000, baseCents: 1_100_000, taxCents: 88_000 });
    expect(s.net.byRate).toEqual([
      { kind: "inc", pct: 8, grossTaxCents: 222_222, creditNoteTaxCents: 88_000, refundTaxCents: 0, taxCents: 134_222 },
    ]);
    expect(s.net.taxCents).toBe(134_222);
    expect(s.net.baseCents).toBe(2_777_778 - 1_100_000);
  });

  it("los reembolsos sin nota restan con el impuesto embebido del tramo del mes", async () => {
    m.invoices.mockResolvedValue([INC_8]);
    sales(3_000_000, 0);
    m.refunds.mockResolvedValue([{ id: "k1", amountCents: 108_000, payment: null }]);
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    expect(s.refunds).toEqual({ grossCents: 108_000, baseCents: 100_000, taxCents: 8_000 });
    expect(s.net.byRate[0]).toMatchObject({ refundTaxCents: 8_000, taxCents: 214_222 });
    expect(s.net.baseCents).toBe(2_777_778 - 100_000);
  });

  it("una nota en una tarifa sin ventas del mes aparece como tramo negativo (saldo a favor)", async () => {
    m.creditNotes.mockResolvedValue([note("1")]);
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    expect(s.byRate).toEqual([]);
    expect(s.net.byRate).toEqual([
      { kind: "inc", pct: 8, grossTaxCents: 0, creditNoteTaxCents: 80_000, refundTaxCents: 0, taxCents: -80_000 },
    ]);
  });
});
