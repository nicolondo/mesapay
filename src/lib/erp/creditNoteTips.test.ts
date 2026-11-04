// Propina devuelta con la nota crédito de anulación: de dónde sale (la regla
// de la propina de la factura), cuándo aplica (sólo anulación) y cómo la
// cruza la contabilidad (cartera, reembolsos antes y después).
import { describe, expect, it } from "vitest";
import {
  allocateTipByCollector,
  collectedTipCents,
  creditNoteTipRefundCents,
  invoiceTipCents,
  isAnnulmentReason,
  snapshotTipCents,
} from "./creditNoteTips";
import {
  creditNotePosting,
  creditNoteTipTargetMonth,
  matchOrderNotesAndRefunds,
  noteAvailableCents,
} from "./creditNoteLedger";

const paid = (tipCents: number, over: Partial<{ status: string; collectedByUserId: string | null }> = {}) => ({
  status: "approved",
  tipCents,
  collectedByUserId: null as string | null,
  ...over,
});

describe("propina de la factura (regla de origen)", () => {
  it("una factura, un cobro: la propina de la cuenta (caso Son y Melona, $61.830)", () => {
    expect(invoiceTipCents({ invoiceTipCents: 6_183_000, orderTipCents: 6_183_000, payments: [paid(6_183_000)] })).toBe(6_183_000);
  });

  it("cuenta dividida: suma la propina de todos los cobros aprobados, efectivo o tarjeta", () => {
    const payments = [paid(2_000_000), paid(3_000_000, { status: "approved" }), paid(1_183_000)];
    expect(collectedTipCents(payments)).toBe(6_183_000);
    expect(invoiceTipCents({ invoiceTipCents: 6_183_000, orderTipCents: 6_183_000, payments })).toBe(6_183_000);
  });

  it("un cobro reembolsado sí se cobró; pendientes, rechazados y anulados no", () => {
    const payments = [
      paid(1_000_000, { status: "refunded" }),
      paid(500_000, { status: "pending" }),
      paid(700_000, { status: "declined" }),
      paid(300_000, { status: "cancelled" }),
    ];
    expect(collectedTipCents(payments)).toBe(1_000_000);
  });

  it("nunca devuelve más de lo cobrado: el mínimo entre factura, cuenta y cobros", () => {
    // Factura emitida con 61.830 pero un cobro de propina se anuló después.
    expect(invoiceTipCents({ invoiceTipCents: 6_183_000, orderTipCents: 6_183_000, payments: [paid(4_000_000)] })).toBe(4_000_000);
    // La cuenta quedó con menos propina que la congelada en la factura.
    expect(invoiceTipCents({ invoiceTipCents: 6_183_000, orderTipCents: 5_000_000, payments: [paid(6_183_000)] })).toBe(5_000_000);
    // La factura congeló menos que lo cobrado.
    expect(invoiceTipCents({ invoiceTipCents: 1_000_000, orderTipCents: 6_183_000, payments: [paid(6_183_000)] })).toBe(1_000_000);
  });

  it("sin propina (o sin datos de la factura): 0", () => {
    expect(invoiceTipCents({ invoiceTipCents: 0, orderTipCents: 0, payments: [paid(0)] })).toBe(0);
    expect(invoiceTipCents({ invoiceTipCents: null, orderTipCents: undefined, payments: [] })).toBe(0);
    // Factura vieja sin `tipCents` en el snapshot: cuenta y cobros deciden.
    expect(invoiceTipCents({ invoiceTipCents: snapshotTipCents({}), orderTipCents: 800_000, payments: [paid(800_000)] })).toBe(800_000);
  });

  it("varias facturas por cuenta no existen: SimpleInvoice.orderId es único, la factura cubre la cuenta entera", () => {
    // Por eso la parte de la factura es toda la propina de la cuenta; si la
    // cuenta tuviera más cobros que la propina congelada, manda la factura.
    expect(invoiceTipCents({ invoiceTipCents: 3_000_000, orderTipCents: 6_000_000, payments: [paid(3_000_000), paid(3_000_000)] })).toBe(3_000_000);
  });

  it("snapshotTipCents lee la propina congelada y descarta basura", () => {
    expect(snapshotTipCents({ tipCents: 6_183_000 })).toBe(6_183_000);
    expect(snapshotTipCents({ tipCents: "6183000" })).toBeNull();
    expect(snapshotTipCents(null)).toBeNull();
    expect(snapshotTipCents({ tipCents: -5 })).toBe(0);
  });
});

describe("sólo la ANULACIÓN (motivo DIAN 2) devuelve la propina", () => {
  const source = { invoiceTipCents: 6_183_000, orderTipCents: 6_183_000, payments: [paid(6_183_000)] };
  it("anulación: toda la propina de la factura", () => {
    expect(isAnnulmentReason("2")).toBe(true);
    expect(creditNoteTipRefundCents("2", source)).toBe(6_183_000);
  });
  it.each(["1", "3", "4", "5", "6"])("motivo %s (parcial u otro ajuste): la propina no se toca", (code) => {
    expect(isAnnulmentReason(code)).toBe(false);
    expect(creditNoteTipRefundCents(code, source)).toBe(0);
  });
});

describe("reparto de la propina devuelta entre quienes la cobraron", () => {
  it("proporcional a la propina de cada cobro; la suma es exacta", () => {
    const r = allocateTipByCollector(1_000, [
      paid(1, { collectedByUserId: "ana" }),
      paid(1, { collectedByUserId: "ana" }),
      paid(1, { collectedByUserId: "luis" }),
    ]);
    expect(r).toEqual([
      { userId: "ana", cents: 667 },
      { userId: "luis", cents: 333 },
    ]);
    expect(r.reduce((s, x) => s + x.cents, 0)).toBe(1_000);
  });
  it("cobro del comensal desde su QR: queda sin mesero (null)", () => {
    expect(allocateTipByCollector(500, [paid(500)])).toEqual([{ userId: null, cents: 500 }]);
  });
  it("sin propina que repartir: nada", () => {
    expect(allocateTipByCollector(0, [paid(500, { collectedByUserId: "ana" })])).toEqual([]);
  });
});

describe("contabilidad de la propina devuelta (lógica pura)", () => {
  const slices = [{ kind: "inc" as const, pct: 8, baseCents: 572_500, taxCents: 45_800, grossCents: 618_300 }];

  it("lo que la nota reconoce fuera de cartera incluye la propina (ya fijada)", () => {
    expect(noteAvailableCents({ totalCents: 618_300, receivableCents: 0, tipRefundCents: 61_830, tipReceivableCents: 0 })).toBe(680_130);
    expect(noteAvailableCents({ totalCents: 618_300, receivableCents: 618_300, tipRefundCents: 61_830, tipReceivableCents: 61_830 })).toBe(0);
    // Propina sin fijar todavía: no cuenta (los reembolsos no la cruzan).
    expect(noteAvailableCents({ totalCents: 618_300, receivableCents: 0, tipRefundCents: 61_830, tipReceivableCents: null })).toBe(618_300);
  });

  it("anulación pagada de contado: la propina entera a reintegros por pagar; cuadra", () => {
    const p = creditNotePosting({ id: "n", slices, totalCents: 618_300, receivableCents: 0, coveredByPriorRefundsCents: 0, tipRefundCents: 61_830, tipReceivableCents: 0 });
    expect(p.liabilityCents).toBe(618_300);
    expect(p.tip).toEqual({ refundCents: 61_830, receivableCents: 0, liabilityCents: 61_830, coveredByPriorRefundsCents: 0 });
    const t = p.tip!;
    expect(t.refundCents).toBe(t.receivableCents + t.liabilityCents + t.coveredByPriorRefundsCents);
  });

  it("parcial: sin propina (todo en 0)", () => {
    const p = creditNotePosting({ id: "n", slices, totalCents: 618_300, receivableCents: 0, coveredByPriorRefundsCents: 0 });
    expect(p.tip).toEqual({ refundCents: 0, receivableCents: 0, liabilityCents: 0, coveredByPriorRefundsCents: 0 });
  });

  it("reembolso anterior: cubre primero la parte fiscal y lo que sobra, la propina", () => {
    const match = matchOrderNotesAndRefunds(
      [{ id: "n", at: new Date("2026-10-26T20:00:00Z"), availableCents: 680_130 }],
      [{ id: "r", at: new Date("2026-10-20T15:00:00Z"), amountCents: 650_000 }],
    );
    const covered = match.notes.get("n")!.coveredByPriorRefundsCents;
    expect(covered).toBe(650_000);
    const p = creditNotePosting({ id: "n", slices, totalCents: 618_300, receivableCents: 0, coveredByPriorRefundsCents: covered, tipRefundCents: 61_830, tipReceivableCents: 0 });
    expect(p.slices).toEqual([]);
    expect(p.liabilityCents).toBe(0);
    expect(p.tip).toMatchObject({ coveredByPriorRefundsCents: 31_700, liabilityCents: 30_130 });
    // Lo que el comercio todavía le debe al cliente = cobrado − reembolsado.
    expect(p.liabilityCents + p.tip!.liabilityCents).toBe(680_130 - 650_000);
  });

  it("reembolso posterior de lo cobrado: todo cancela el pasivo, nada queda como devolución sin nota", () => {
    const match = matchOrderNotesAndRefunds(
      [{ id: "n", at: new Date("2026-10-26T20:00:00Z"), availableCents: 680_130 }],
      [{ id: "r", at: new Date("2026-10-28T15:00:00Z"), amountCents: 680_130 }],
    );
    expect(match.refunds.get("r")).toEqual({ liabilityDebitCents: 680_130, coveredByLaterNoteCents: 0 });
  });

  it("mes de la propina: el de la nota; si esa nota quedó en un mes cerrado, el primer mes abierto", () => {
    expect(creditNoteTipTargetMonth({ postedMonth: null, fiscalMonth: "2026-10" }, null)).toBe("2026-10");
    expect(creditNoteTipTargetMonth({ postedMonth: "2026-10", fiscalMonth: "2026-10" }, "2026-09")).toBe("2026-10");
    expect(creditNoteTipTargetMonth({ postedMonth: "2026-10", fiscalMonth: "2026-10" }, "2026-10")).toBe("2026-11");
    expect(creditNoteTipTargetMonth({ postedMonth: null, fiscalMonth: "2026-09" }, "2026-10")).toBe("2026-11");
  });
});
