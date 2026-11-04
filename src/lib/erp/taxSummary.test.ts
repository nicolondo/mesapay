// El impuesto de ventas del mes sale de lo FACTURADO (la tarifa que cada
// tirilla congeló), no de "tarifa de hoy × ventas del mes". Prender el
// impoconsumo hoy no puede recalcular septiembre.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  restaurant: vi.fn(),
  orders: vi.fn(),
  creditNotes: vi.fn(),
  refunds: vi.fn(),
  expenses: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    order: { findMany: m.orders },
    purchaseOrder: { findMany: async () => [] },
    expense: { findMany: m.expenses },
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

type Snap = { snapshot: Record<string, unknown> & { subtotalCents: number } };
/** Pedidos pagados del mes: facturados (con su snapshot) y sin factura (sólo el subtotal). */
function sales(invoiced: Snap[], uninvoicedCents: number[] = []) {
  m.orders.mockResolvedValue([
    ...invoiced.map((i) => ({ subtotalCents: i.snapshot.subtotalCents, simpleInvoice: { snapshot: i.snapshot } })),
    ...uninvoicedCents.map((subtotalCents) => ({ subtotalCents, simpleInvoice: null })),
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurant.mockResolvedValue({ salesTaxKind: "inc", salesTaxPct: 8 });
  m.creditNotes.mockResolvedValue([]);
  m.refunds.mockResolvedValue([]);
  m.expenses.mockResolvedValue([]);
  sales([]);
});

describe("computeTaxSummary — gastos con impuestos", () => {
  it("suma el IVA de los gastos (y aparte sólo el DESCONTABLE), su INC y sus retenciones; filtra por mes calendario", async () => {
    m.expenses.mockResolvedValue([
      { ivaCents: 38_000, ivaDeductible: true, incCents: 0, retefuenteCents: 8_000, reteIvaCents: 5_700, reteIcaCents: 1_400 },
      { ivaCents: 19_000, ivaDeductible: false, incCents: 8_000, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0 },
    ]);
    const calendar = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") };
    const tax = await computeTaxSummary("r1", { ...RANGE, calendar });
    expect(tax.purchases).toEqual({
      // Registrado: 38.000 descontable + 19.000 que es costo del gasto.
      ivaCents: 57_000,
      ivaDeductibleCents: 38_000,
      incCents: 8_000,
      retefuenteCents: 8_000,
      reteIvaCents: 5_700,
      reteIcaCents: 1_400,
    });
    expect(tax.expenses).toMatchObject({ ivaCents: 57_000, deductibleIvaCents: 38_000 });
    const where = m.expenses.mock.calls[0]![0].where;
    expect(where).toMatchObject({ restaurantId: "r1", recurring: false, date: { gte: calendar.from, lt: calendar.to } });
  });
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
    sales([INC_8, IVA_19, OLD, NONE]);
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
    sales([NONE, OLD]);
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
    sales([INC_8]);
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    expect(s.byRate).toEqual([
      { kind: "inc", pct: 8, grossCents: 3_000_000, taxCents: 222_222, baseCents: 2_777_778 },
    ]);
    expect(s.kind).toBe("inc");
    expect(s.taxCents).toBe(222_222);
  });

  it("las ventas SIN factura siguen con la tarifa actual del comercio (no hay documento que las congele)", async () => {
    sales([INC_8], [250_000]);
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
      freeLines: { taxCents: 0, byRate: [] },
      creditNotes: { count: 0, grossCents: 0, baseCents: 0, taxCents: 0 },
      refunds: { grossCents: 0, baseCents: 0, taxCents: 0 },
      net: { baseCents: 0, taxCents: 0, byRate: [] },
    });
  });

  it("corta el mes por la fecha de pago de la orden, como el libro de ventas", async () => {
    await computeTaxSummary("rest-1", RANGE);
    expect(m.orders).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { restaurantId: "rest-1", status: "paid", paidAt: { gte: RANGE.from, lt: RANGE.to } },
      }),
    );
  });

  it("el impuesto de las ventas sin factura se redondea por pedido: la suma no depende de cómo se agrupen", async () => {
    // Tres cuentas sin factura: 8/108 de cada una, redondeado pedido a pedido
    // (18.519 + 7.316 + 823 = 26.658; sobre la suma daría 26.657).
    sales([], [250_000, 98_765, 11_111]);
    const { sales: s } = await computeTaxSummary("rest-1", RANGE);
    expect(s.byRate).toEqual([
      { kind: "inc", pct: 8, grossCents: 359_876, taxCents: 26_658, baseCents: 333_218 },
    ]);
  });
});

describe("computeTaxSummary — mes de negocio (accountingMonthRange)", () => {
  // Octubre con corte 5: los timestamps van del 1-oct 10:00Z al 1-nov 10:00Z;
  // las FECHAS (día fiscal de las notas) por el mes calendario.
  const BUSINESS = {
    from: new Date("2026-10-01T10:00:00.000Z"),
    to: new Date("2026-11-01T10:00:00.000Z"),
    calendar: { from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-11-01T00:00:00.000Z") },
  };

  it("los pedidos cortan por el rango de negocio y las notas crédito por el mes calendario de su día fiscal", async () => {
    sales([INC_8]);
    m.creditNotes.mockResolvedValue([
      // 31-oct a las 10 p. m. de Bogotá (1-nov 03:00Z): octubre.
      note("oct", { issuedAt: "2026-11-01T03:00:00Z", base: 100_000, tax: 8_000 }),
      // 1-nov a las 2 a. m. de Bogotá (07:00Z): cae dentro del rango de negocio de
      // octubre, pero su día FISCAL es noviembre — no resta en octubre.
      note("nov", { issuedAt: "2026-11-01T07:00:00Z" }),
    ]);
    const { sales: s } = await computeTaxSummary("rest-1", BUSINESS);
    expect(m.orders).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { restaurantId: "rest-1", status: "paid", paidAt: { gte: BUSINESS.from, lt: BUSINESS.to } },
      }),
    );
    expect(s.creditNotes).toEqual({ count: 1, grossCents: 108_000, baseCents: 100_000, taxCents: 8_000 });
    // Los reembolsos sin nota se buscan con el rango de negocio (timestamps).
    expect(m.refunds).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: BUSINESS.from, lt: BUSINESS.to } }) }),
    );
  });

  it("sin `calendar` (rango UTC a secas) el comportamiento es el de siempre", async () => {
    m.creditNotes.mockResolvedValue([note("oct", { issuedAt: "2026-11-01T03:00:00Z" })]);
    const { sales: s } = await computeTaxSummary("rest-1", {
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(s.creditNotes.count).toBe(1);
  });
});

describe("computeTaxSummary — notas crédito y devoluciones", () => {
  it("el bruto no cambia (lo asienta «Ventas del mes»); el neto resta las notas aceptadas del mes en su tarifa", async () => {
    sales([INC_8]);
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
    sales([INC_8]);
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
