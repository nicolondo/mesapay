// Capa con DB de la contabilidad de notas crédito (Prisma mockeado): qué
// notas cuentan (sólo aceptadas y no descartadas), en qué mes entran (mes
// cerrado ⇒ primer mes abierto), cuánto cancela cartera de cliente y cómo
// se cruzan con los reembolsos del mismo pedido.
import { beforeEach, describe, expect, it, vi } from "vitest";

type NoteFixture = {
  id: string;
  documentNumber: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  snapshot: unknown;
  receivableCents: number | null;
  postedMonth: string | null;
  tipRefundCents: number | null;
  tipReceivableCents: number | null;
  tipPostedMonth: string | null;
  createdAt: Date;
  dianDocument: { issuedAt: Date | null };
  originalInvoice: { orderId: string };
};
type RefundFixture = { id: string; amountCents: number; createdAt: Date; payment: { orderId: string } | null };

const m = vi.hoisted(() => ({
  notes: [] as unknown[],
  pendingStamps: [] as { id: string }[],
  refunds: [] as unknown[],
  closedThrough: null as string | null,
  noteFindFirst: vi.fn(),
  noteUpdateMany: vi.fn(),
  paymentFindMany: vi.fn(),
  paymentUpdate: vi.fn(),
  summary: vi.fn(),
  noteFindManyCalls: [] as unknown[],
}));

vi.mock("@/lib/db", () => {
  const creditNote = {
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
      m.noteFindManyCalls.push(args);
      const where = args.where;
      const or = where.OR as Array<Record<string, unknown>> | undefined;
      if (or?.some((c) => c.accountingStampedAt === null)) return m.pendingStamps;
      const byOrder = (where.originalInvoice as { orderId?: { in: string[] } } | undefined)?.orderId?.in;
      const notes = m.notes as NoteFixture[];
      return byOrder ? notes.filter((n) => byOrder.includes(n.originalInvoice.orderId)) : notes;
    }),
    findFirst: m.noteFindFirst,
    updateMany: m.noteUpdateMany,
  };
  const kushkiTransaction = {
    findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
      const refunds = m.refunds as RefundFixture[];
      const where = args.where as {
        createdAt?: { gte: Date; lt: Date };
        payment?: { orderId: { in: string[] } };
      };
      return refunds.filter(
        (r) =>
          (!where.createdAt || (r.createdAt >= where.createdAt.gte && r.createdAt < where.createdAt.lt)) &&
          (!where.payment || (r.payment && where.payment.orderId.in.includes(r.payment.orderId))),
      );
    }),
  };
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async () => []),
    creditNote,
    payment: { findMany: m.paymentFindMany, update: m.paymentUpdate },
  };
  return {
    db: {
      creditNote,
      kushkiTransaction,
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    },
  };
});
vi.mock("@/lib/customerCredit", () => ({ loadCustomerCreditSummary: m.summary }));
vi.mock("./cierre", () => ({
  getAccountingConfig: async () => ({ uvtCents: 0, closedThrough: m.closedThrough, nextVoucherNumber: 1 }),
}));

import { NO_TIP_POSTING } from "./creditNoteLedger";
import {
  acceptedCreditNoteWhere,
  loadCreditNoteMonthPosting,
  loadRefundMonthPosting,
  loadUnlinkedRefundsCents,
  stampCreditNoteAccounting,
} from "./creditNoteAccounting";

const lineIva = (base: number) => ({
  originalLineId: "l1",
  description: "Plato",
  quantity: 1,
  unitPriceCents: base,
  lineTotalCents: base,
  taxCents: Math.round(base * 0.19),
  grossCents: base + Math.round(base * 0.19),
  taxPct: "19.00",
  taxSchemeId: "01",
});
const lineInc = (base: number) => ({
  ...lineIva(base),
  taxCents: Math.round(base * 0.08),
  grossCents: base + Math.round(base * 0.08),
  taxPct: "8.00",
  taxSchemeId: "04",
});

function fixture(over: Partial<NoteFixture> & { id: string; lines: ReturnType<typeof lineIva>[]; issuedAt: string; orderId?: string }): NoteFixture {
  const { lines, issuedAt, orderId, ...rest } = over;
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const tax = lines.reduce((s, l) => s + l.taxCents, 0);
  return {
    documentNumber: `NC-${over.id}`,
    subtotalCents: subtotal,
    taxCents: tax,
    totalCents: subtotal + tax,
    snapshot: { version: 1, lines, original: { invoiceNumber: "FE1" } },
    receivableCents: 0,
    postedMonth: null,
    tipRefundCents: 0,
    tipReceivableCents: 0,
    tipPostedMonth: null,
    createdAt: new Date(issuedAt),
    dianDocument: { issuedAt: new Date(issuedAt) },
    originalInvoice: { orderId: orderId ?? `o-${over.id}` },
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.notes = [];
  m.pendingStamps = [];
  m.refunds = [];
  m.closedThrough = null;
  m.noteFindManyCalls = [];
});

describe("sólo cuentan las notas aceptadas por la DIAN y no descartadas", () => {
  it("el filtro exige DianDocument aceptado y abandonedAt nulo (rechazada o descartada no cuenta)", () => {
    expect(acceptedCreditNoteWhere("r1")).toEqual({
      restaurantId: "r1",
      abandonedAt: null,
      dianDocument: { is: { state: "accepted" } },
      originalInvoice: { is: { order: { is: { paidAt: { not: null }, compedAt: null } } } },
    });
  });

  it("una nota sobre una factura emitida antes de cobrar y NUNCA cobrada (anulada y cerrada como cortesía) no toca libros: ni la venta ni su anulación entraron", () => {
    // Lo que entra a libros es la cuenta COBRADA (paidAt) que no es
    // cortesía: la misma regla que la venta en posting.ts. Una cuenta
    // abierta (paidAt null) o cerrada sin cobro (compedAt) queda fuera.
    const where = acceptedCreditNoteWhere("r1");
    expect(where.originalInvoice).toEqual({
      is: { order: { is: { paidAt: { not: null }, compedAt: null } } },
    });
  });

  it("la consulta del mes usa ese filtro y sólo notas ya fijadas", async () => {
    await loadCreditNoteMonthPosting("r1", "2026-10");
    const candidates = m.noteFindManyCalls.find(
      (c) => (c as { where: { accountingStampedAt?: unknown } }).where.accountingStampedAt !== undefined,
    ) as { where: Record<string, unknown> };
    expect(candidates.where).toMatchObject({
      restaurantId: "r1",
      abandonedAt: null,
      dianDocument: { is: { state: "accepted" } },
      accountingStampedAt: { not: null },
      OR: [{ postedMonth: "2026-10" }, { postedMonth: null }, { tipPostedMonth: "2026-10" }, { tipPostedMonth: null }],
    });
  });
});

describe("loadCreditNoteMonthPosting — mes contable", () => {
  it("nota de un mes ABIERTO entra en su mes fiscal (día colombiano), por tarifa", async () => {
    m.notes = [
      // 1-oct 03:00Z = 30-sep en Bogotá: es de septiembre.
      fixture({ id: "sep", lines: [lineIva(100_000), lineInc(50_000)], issuedAt: "2026-10-01T03:00:00Z" }),
      fixture({ id: "oct", lines: [lineIva(10_000)], issuedAt: "2026-10-05T15:00:00Z" }),
    ];
    const sep = await loadCreditNoteMonthPosting("r1", "2026-09");
    expect(sep.noteIds).toEqual(["sep"]);
    expect(sep.notes[0]).toEqual({
      id: "sep",
      slices: [
        { kind: "iva", pct: 19, baseCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
        { kind: "inc", pct: 8, baseCents: 50_000, taxCents: 4_000, grossCents: 54_000 },
      ],
      receivableCents: 0,
      liabilityCents: 173_000,
      tip: NO_TIP_POSTING,
      // Día fiscal (colombiano): el motor asienta la nota ese día.
      fiscalDate: "2026-09-30",
      postsFiscal: true,
      postsTip: true,
    });
    const oct = await loadCreditNoteMonthPosting("r1", "2026-10");
    expect(oct.noteIds).toEqual(["oct"]);
    expect(oct.notes[0]!.fiscalDate).toBe("2026-10-05");
  });

  it("mes fiscal CERRADO: la nota entra en el primer mes abierto; ya asentada, se queda en su mes", async () => {
    m.closedThrough = "2026-09";
    m.notes = [
      fixture({ id: "late", lines: [lineIva(10_000)], issuedAt: "2026-09-20T15:00:00Z" }),
      fixture({ id: "posted", lines: [lineIva(10_000)], issuedAt: "2026-09-02T15:00:00Z", postedMonth: "2026-09" }),
    ];
    const r = await loadCreditNoteMonthPosting("r1", "2026-10");
    expect(r.noteIds).toEqual(["late"]);
    // Conserva su día fiscal (septiembre): el motor la lleva al último día de octubre.
    expect(r.notes[0]!.fiscalDate).toBe("2026-09-20");
  });

  it("una nota que no cuadra al centavo se excluye y queda en el log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = fixture({ id: "bad", lines: [lineIva(10_000)], issuedAt: "2026-10-05T15:00:00Z" });
    bad.totalCents += 1;
    m.notes = [bad, fixture({ id: "ok", lines: [lineIva(10_000)], issuedAt: "2026-10-06T15:00:00Z" })];
    const r = await loadCreditNoteMonthPosting("r1", "2026-10");
    expect(r.noteIds).toEqual(["ok"]);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("no cuadra"),
      expect.objectContaining({ creditNoteId: "bad", reason: "total_mismatch" }),
    );
    spy.mockRestore();
  });

  it("la parte que cancela cartera va a Clientes y el resto al pasivo", async () => {
    m.notes = [fixture({ id: "n", lines: [lineIva(100_000)], issuedAt: "2026-10-05T15:00:00Z", receivableCents: 40_000 })];
    const r = await loadCreditNoteMonthPosting("r1", "2026-10");
    expect(r.notes[0]).toMatchObject({ receivableCents: 40_000, liabilityCents: 79_000 });
  });

  it("un reembolso ANTERIOR a la nota en el mismo pedido no se vuelve a asentar en la nota", async () => {
    m.notes = [fixture({ id: "n", lines: [lineIva(100_000)], issuedAt: "2026-10-05T15:00:00Z", orderId: "o1" })];
    m.refunds = [{ id: "r1", amountCents: 119_000, createdAt: new Date("2026-10-02T15:00:00Z"), payment: { orderId: "o1" } }];
    const r = await loadCreditNoteMonthPosting("r1", "2026-10");
    expect(r).toEqual({
      noteIds: ["n"],
      tipNoteIds: ["n"],
      notes: [
        {
          id: "n",
          slices: [],
          receivableCents: 0,
          liabilityCents: 0,
          tip: NO_TIP_POSTING,
          fiscalDate: "2026-10-05",
          postsFiscal: true,
          postsTip: true,
        },
      ],
    });
  });
});

describe("reembolsos y notas del mismo pedido", () => {
  beforeEach(() => {
    m.notes = [fixture({ id: "n", lines: [lineIva(100_000)], issuedAt: "2026-09-25T15:00:00Z", orderId: "o1" })];
    m.refunds = [
      // Después de la nota, en octubre: cancela el pasivo (119.000) y sobra 1.000.
      { id: "after", amountCents: 120_000, createdAt: new Date("2026-10-03T15:00:00Z"), payment: { orderId: "o1" } },
      // Otro pedido sin nota: devolución normal.
      { id: "other", amountCents: 50_000, createdAt: new Date("2026-10-04T15:00:00Z"), payment: { orderId: "o2" } },
    ];
  });
  const october = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };

  it("asiento refund: la parte cubierta por la nota anterior cancela el pasivo, no debita devoluciones", async () => {
    // Reembolso por reembolso (el motor los agrupa por día) y los totales del mes.
    expect(await loadRefundMonthPosting("r1", october)).toEqual({
      refunds: [
        { id: "after", createdAt: new Date("2026-10-03T15:00:00Z"), amountCents: 120_000, liabilityCents: 119_000 },
        { id: "other", createdAt: new Date("2026-10-04T15:00:00Z"), amountCents: 50_000, liabilityCents: 0 },
      ],
      totalCents: 170_000,
      liabilityCents: 119_000,
    });
  });

  it("reportes de impuestos: sólo restan los reembolsos SIN nota ligada", async () => {
    expect(await loadUnlinkedRefundsCents("r1", october.from, october.to)).toBe(1_000 + 50_000);
  });
});

describe("stampCreditNoteAccounting — cartera de cliente", () => {
  const note = (over: Record<string, unknown> = {}) => ({
    id: "n",
    totalCents: 100_000,
    reasonCode: "1",
    receivableCents: null,
    accountingStampedAt: null,
    tipRefundCents: 0,
    originalInvoice: { orderId: "o1", order: { tipCents: 0 } },
    ...over,
  });
  const creditCharge = { id: "p1", method: "customer_credit", status: "approved", tipCents: 0, billingCustomerId: "c1" };
  beforeEach(() => {
    m.noteFindFirst.mockResolvedValue(note());
    m.noteUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("cuenta a crédito con saldo: baja la deuda del cargo y fija esa parte en la nota", async () => {
    m.paymentFindMany.mockResolvedValue([creditCharge]);
    m.summary.mockResolvedValue({ fifo: { charges: [{ chargeId: "p1", outstandingCents: 60_000 }] } });
    expect(await stampCreditNoteAccounting("r1", "n", new Date("2026-10-06T12:00:00Z"))).toBe(true);
    expect(m.summary).toHaveBeenCalledWith("r1", "c1", expect.anything());
    expect(m.paymentUpdate).toHaveBeenCalledWith({ where: { id: "p1" }, data: { creditNoteCents: { increment: 60_000 } } });
    expect(m.noteUpdateMany).toHaveBeenCalledWith({
      where: { id: "n", restaurantId: "r1", tipReceivableCents: null, accountingStampedAt: null },
      data: {
        receivableCents: 60_000,
        accountingStampedAt: new Date("2026-10-06T12:00:00Z"),
        tipRefundCents: 0,
        tipReceivableCents: 0,
      },
    });
  });

  it("cuenta cobrada de contado (o crédito ya pagado): nada a cartera, todo al pasivo", async () => {
    m.paymentFindMany.mockResolvedValue([{ id: "p1", method: "cash", status: "approved", tipCents: 0, billingCustomerId: null }]);
    expect(await stampCreditNoteAccounting("r1", "n")).toBe(true);
    expect(m.paymentUpdate).not.toHaveBeenCalled();
    expect(m.noteUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ receivableCents: 0 }) }),
    );
  });

  it("sólo actúa sobre notas aceptadas, no descartadas y sin fijar (idempotente)", async () => {
    m.noteFindFirst.mockResolvedValue(null);
    expect(await stampCreditNoteAccounting("r1", "n")).toBe(false);
    expect(m.noteFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "n",
          abandonedAt: null,
          OR: [{ accountingStampedAt: null }, { tipReceivableCents: null }],
          dianDocument: { is: { state: "accepted" } },
        }),
      }),
    );
    expect(m.noteUpdateMany).not.toHaveBeenCalled();
  });
});

describe("stampCreditNoteAccounting — propina devuelta con la anulación", () => {
  beforeEach(() => m.noteUpdateMany.mockResolvedValue({ count: 1 }));
  const annulment = (over: Record<string, unknown> = {}) => ({
    id: "n",
    totalCents: 618_300_00,
    reasonCode: "2",
    receivableCents: null,
    accountingStampedAt: null,
    tipRefundCents: 61_830_00,
    originalInvoice: { orderId: "o1", order: { tipCents: 61_830_00 } },
    ...over,
  });

  it("cuenta a crédito: la parte fiscal y después la propina bajan la deuda del cargo", async () => {
    m.noteFindFirst.mockResolvedValue(annulment());
    m.paymentFindMany.mockResolvedValue([
      { id: "p1", method: "customer_credit", status: "approved", tipCents: 61_830_00, billingCustomerId: "c1" },
    ]);
    m.summary.mockResolvedValue({ fifo: { charges: [{ chargeId: "p1", outstandingCents: 680_130_00 }] } });
    await stampCreditNoteAccounting("r1", "n", new Date("2026-11-04T12:00:00Z"));
    // Un solo incremento por cargo: comida + propina = toda la deuda.
    expect(m.paymentUpdate).toHaveBeenCalledTimes(1);
    expect(m.paymentUpdate).toHaveBeenCalledWith({ where: { id: "p1" }, data: { creditNoteCents: { increment: 680_130_00 } } });
    expect(m.noteUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ receivableCents: 618_300_00, tipRefundCents: 61_830_00, tipReceivableCents: 61_830_00 }),
      }),
    );
  });

  it("crédito con abonos: lo que la parte fiscal no cubre del saldo lo toma la propina; el resto va a reintegros", async () => {
    m.noteFindFirst.mockResolvedValue(annulment());
    m.paymentFindMany.mockResolvedValue([
      { id: "p1", method: "customer_credit", status: "approved", tipCents: 61_830_00, billingCustomerId: "c1" },
    ]);
    // El cliente ya abonó 650.000: le quedan 30.130 por pagar.
    m.summary.mockResolvedValue({ fifo: { charges: [{ chargeId: "p1", outstandingCents: 30_130_00 }] } });
    await stampCreditNoteAccounting("r1", "n");
    expect(m.paymentUpdate).toHaveBeenCalledWith({ where: { id: "p1" }, data: { creditNoteCents: { increment: 30_130_00 } } });
    expect(m.noteUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ receivableCents: 30_130_00, tipReceivableCents: 0 }) }),
    );
  });

  it("nota ANTERIOR a la regla (ya fijada, sin propina): calcula la propina y sólo fija esa parte", async () => {
    m.noteFindFirst.mockResolvedValue(
      annulment({ receivableCents: 0, accountingStampedAt: new Date("2026-10-26T20:00:00Z"), tipRefundCents: null }),
    );
    m.paymentFindMany.mockResolvedValue([
      // Cuenta dividida: dos cobros con su propina (61.830 en total).
      { id: "p1", method: "kushki_card", status: "approved", tipCents: 40_000_00, billingCustomerId: null },
      { id: "p2", method: "cash", status: "approved", tipCents: 21_830_00, billingCustomerId: null },
      { id: "p3", method: "cash", status: "declined", tipCents: 5_000_00, billingCustomerId: null },
    ]);
    await stampCreditNoteAccounting("r1", "n", new Date("2026-11-05T10:00:00Z"));
    expect(m.paymentUpdate).not.toHaveBeenCalled();
    // No vuelve a tocar la parte fiscal (ni la fecha del sello).
    expect(m.noteUpdateMany).toHaveBeenCalledWith({
      where: { id: "n", restaurantId: "r1", tipReceivableCents: null },
      data: { tipRefundCents: 61_830_00, tipReceivableCents: 0 },
    });
  });

  it("nota parcial anterior a la regla: no devuelve propina", async () => {
    m.noteFindFirst.mockResolvedValue(
      annulment({ reasonCode: "1", receivableCents: 0, accountingStampedAt: new Date(), tipRefundCents: null }),
    );
    m.paymentFindMany.mockResolvedValue([{ id: "p1", method: "cash", status: "approved", tipCents: 61_830_00, billingCustomerId: null }]);
    await stampCreditNoteAccounting("r1", "n");
    expect(m.noteUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { tipRefundCents: 0, tipReceivableCents: 0 } }),
    );
  });
});

describe("loadCreditNoteMonthPosting — propina devuelta", () => {
  const annulment = (over: Partial<NoteFixture> = {}) => ({
    ...fixture({ id: "nc3", lines: [lineInc(572_500_00)], issuedAt: "2026-10-26T20:00:00Z", orderId: "o3" }),
    tipRefundCents: 61_830_00,
    tipReceivableCents: 0,
    ...over,
  });

  it("la propina va con su nota: mismo mes y día, todo a reintegros por pagar", async () => {
    m.notes = [annulment()];
    const r = await loadCreditNoteMonthPosting("r1", "2026-10");
    expect(r.noteIds).toEqual(["nc3"]);
    expect(r.tipNoteIds).toEqual(["nc3"]);
    expect(r.notes[0]).toMatchObject({
      fiscalDate: "2026-10-26",
      liabilityCents: 618_300_00,
      tip: { refundCents: 61_830_00, receivableCents: 0, liabilityCents: 61_830_00, coveredByPriorRefundsCents: 0 },
    });
  });

  it("nota ya asentada en un mes CERRADO antes de la regla: sólo su propina, en el primer mes abierto", async () => {
    m.closedThrough = "2026-10";
    m.notes = [annulment({ postedMonth: "2026-10" })];
    // (Octubre está cerrado y no se regenera; si se regenerara, sólo traería la parte fiscal.)
    expect((await loadCreditNoteMonthPosting("r1", "2026-10")).tipNoteIds).toEqual([]);
    const nov = await loadCreditNoteMonthPosting("r1", "2026-11");
    expect(nov.noteIds).toEqual([]);
    expect(nov.tipNoteIds).toEqual(["nc3"]);
    expect(nov.notes[0]).toMatchObject({
      slices: [],
      receivableCents: 0,
      liabilityCents: 0,
      postsFiscal: false,
      postsTip: true,
      tip: { refundCents: 61_830_00, liabilityCents: 61_830_00 },
    });
  });

  it("nota asentada en un mes ABIERTO: la propina entra en ese mismo mes, no en otro", async () => {
    m.notes = [annulment({ postedMonth: "2026-10" })];
    expect((await loadCreditNoteMonthPosting("r1", "2026-11")).notes).toEqual([]);
    expect((await loadCreditNoteMonthPosting("r1", "2026-10")).tipNoteIds).toEqual(["nc3"]);
  });

  it("propina ya asentada en un mes: no se vuelve a asentar en otro (regenerar es idempotente)", async () => {
    m.notes = [annulment({ postedMonth: "2026-10", tipPostedMonth: "2026-10" })];
    const oct1 = await loadCreditNoteMonthPosting("r1", "2026-10");
    const oct2 = await loadCreditNoteMonthPosting("r1", "2026-10");
    expect(oct2).toEqual(oct1);
    m.closedThrough = "2026-10";
    expect((await loadCreditNoteMonthPosting("r1", "2026-11")).notes).toEqual([]);
  });

  it("propina todavía sin fijar (sello pendiente): la nota se asienta, la propina espera", async () => {
    m.notes = [annulment({ tipRefundCents: null, tipReceivableCents: null })];
    const r = await loadCreditNoteMonthPosting("r1", "2026-10");
    expect(r.noteIds).toEqual(["nc3"]);
    expect(r.tipNoteIds).toEqual([]);
  });

  it("reembolso ANTERIOR por todo lo cobrado (comida + propina): la nota no repite nada y la propina se reclasifica", async () => {
    m.notes = [annulment()];
    m.refunds = [{ id: "before", amountCents: 680_130_00, createdAt: new Date("2026-10-20T15:00:00Z"), payment: { orderId: "o3" } }];
    const r = await loadCreditNoteMonthPosting("r1", "2026-10");
    expect(r.notes[0]).toMatchObject({
      slices: [],
      liabilityCents: 0,
      tip: { refundCents: 61_830_00, liabilityCents: 0, coveredByPriorRefundsCents: 61_830_00 },
    });
  });

  it("reembolso POSTERIOR por todo lo cobrado: cancela el pasivo de la nota Y de la propina, sin sobrante", async () => {
    m.notes = [annulment()];
    m.refunds = [{ id: "after", amountCents: 680_130_00, createdAt: new Date("2026-10-28T15:00:00Z"), payment: { orderId: "o3" } }];
    const october = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };
    const refunds = await loadRefundMonthPosting("r1", october);
    expect(refunds.refunds[0]).toMatchObject({ amountCents: 680_130_00, liabilityCents: 680_130_00 });
    // Y los reportes de impuestos no lo restan como devolución sin nota.
    expect(await loadUnlinkedRefundsCents("r1", october.from, october.to)).toBe(0);
  });
});
