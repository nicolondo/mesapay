// Contabilidad de las notas crédito — reglas puras: dato por tarifa (y
// validación al centavo), mes contable con meses cerrados, cartera de
// cliente y cruce cronológico con los reembolsos del mismo pedido.
import { describe, expect, it } from "vitest";
import {
  allocateReceivable,
  belongsToMonth,
  creditNoteAccountingStatus,
  creditNoteFiscalDate,
  creditNotePosting,
  creditNoteTargetMonth,
  creditNoteTaxSlices,
  matchOrderNotesAndRefunds,
  nextMonth,
  prorateSlices,
  refundLinkedCents,
  sumSlices,
  type CreditNoteLineInput,
} from "./creditNoteLedger";

const line = (base: number, tax: number, pct: string, scheme: "01" | "04"): CreditNoteLineInput => ({
  lineTotalCents: base,
  taxCents: tax,
  grossCents: base + tax,
  taxPct: pct,
  taxSchemeId: scheme,
});
const note = (lines: CreditNoteLineInput[]) => ({
  subtotalCents: lines.reduce((s, l) => s + l.lineTotalCents, 0),
  taxCents: lines.reduce((s, l) => s + l.taxCents, 0),
  totalCents: lines.reduce((s, l) => s + l.grossCents, 0),
  lines,
});

describe("creditNoteTaxSlices — dato contable por tarifa", () => {
  it("nota TOTAL con IVA 19 %, INC 8 % y una línea excluida: un tramo por tarifa que cuadra", () => {
    const r = creditNoteTaxSlices(
      note([
        line(100_000, 19_000, "19.00", "01"),
        line(20_000, 1_600, "8.00", "04"),
        line(30_000, 2_400, "8.00", "04"),
        line(5_000, 0, "0.00", "04"),
      ]),
    );
    expect(r).toEqual({
      ok: true,
      slices: [
        { kind: "iva", pct: 19, baseCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
        { kind: "inc", pct: 8, baseCents: 50_000, taxCents: 4_000, grossCents: 54_000 },
        { kind: "none", pct: 0, baseCents: 5_000, taxCents: 0, grossCents: 5_000 },
      ],
    });
  });

  it("nota PARCIAL (montos por línea con impuesto incluido, como los arma buildProposal)", () => {
    // 54.001 brutos de una línea INC 8 %: 50.001 base + 4.000 impuesto.
    const r = creditNoteTaxSlices(note([line(50_001, 4_000, "8.00", "04")]));
    expect(r).toEqual({
      ok: true,
      slices: [{ kind: "inc", pct: 8, baseCents: 50_001, taxCents: 4_000, grossCents: 54_001 }],
    });
  });

  it("una nota que no cuadra al centavo con sus totales se excluye", () => {
    const n = note([line(100_000, 19_000, "19.00", "01")]);
    expect(creditNoteTaxSlices({ ...n, totalCents: n.totalCents + 1 })).toEqual({ ok: false, reason: "total_mismatch" });
    expect(creditNoteTaxSlices({ ...n, taxCents: n.taxCents - 1 })).toEqual({ ok: false, reason: "total_mismatch" });
    expect(
      creditNoteTaxSlices({ ...n, lines: [{ ...n.lines[0]!, grossCents: 119_001 }] }),
    ).toEqual({ ok: false, reason: "line_mismatch" });
    expect(creditNoteTaxSlices({ ...n, lines: [] })).toEqual({ ok: false, reason: "empty" });
    // Impuesto en una línea sin tarifa: no es un perfil válido.
    expect(creditNoteTaxSlices(note([line(1_000, 10, "0.00", "01")]))).toEqual({ ok: false, reason: "line_mismatch" });
  });

  it("sumSlices suma varias notas por tarifa", () => {
    const a = [{ kind: "iva" as const, pct: 19, baseCents: 100, taxCents: 19, grossCents: 119 }];
    const b = [
      { kind: "iva" as const, pct: 19, baseCents: 200, taxCents: 38, grossCents: 238 },
      { kind: "inc" as const, pct: 8, baseCents: 100, taxCents: 8, grossCents: 108 },
    ];
    expect(sumSlices([a, b])).toEqual([
      { kind: "iva", pct: 19, baseCents: 300, taxCents: 57, grossCents: 357 },
      { kind: "inc", pct: 8, baseCents: 100, taxCents: 8, grossCents: 108 },
    ]);
  });

  it("prorateSlices reparte un bruto exacto entre tramos y respeta la proporción del impuesto", () => {
    const slices = [
      { kind: "iva" as const, pct: 19, baseCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
      { kind: "inc" as const, pct: 8, baseCents: 50_000, taxCents: 4_000, grossCents: 54_000 },
    ];
    const half = prorateSlices(slices, 86_500);
    expect(half.reduce((s, x) => s + x.grossCents, 0)).toBe(86_500);
    expect(half.every((x) => x.baseCents + x.taxCents === x.grossCents)).toBe(true);
    expect(half[0]).toMatchObject({ kind: "iva", grossCents: 59_500, taxCents: 9_500 });
    expect(prorateSlices(slices, 0)).toEqual([]);
    expect(prorateSlices(slices, 173_000)).toEqual(slices);
  });
});

describe("fecha fiscal y mes contable", () => {
  it("la fecha fiscal es el día colombiano del instante firmado (no el día UTC)", () => {
    // 1-oct 03:00Z = 30-sep 22:00 en Bogotá: la nota es de SEPTIEMBRE.
    expect(creditNoteFiscalDate(new Date("2026-10-01T03:00:00Z"))).toBe("2026-09-30");
    expect(creditNoteFiscalDate(new Date("2026-10-01T05:00:00Z"))).toBe("2026-10-01");
  });

  it("mes abierto: el fiscal; mes cerrado: el primer mes abierto", () => {
    expect(creditNoteTargetMonth("2026-09", null)).toBe("2026-09");
    expect(creditNoteTargetMonth("2026-09", "2026-08")).toBe("2026-09");
    expect(creditNoteTargetMonth("2026-09", "2026-09")).toBe("2026-10");
    expect(creditNoteTargetMonth("2026-09", "2026-11")).toBe("2026-12");
    expect(nextMonth("2026-12")).toBe("2027-01");
  });

  it("una nota ya asentada se queda en su mes aunque después se cierre o reabra otro", () => {
    const posted = { postedMonth: "2026-10", fiscalMonth: "2026-09" };
    expect(belongsToMonth(posted, "2026-10", "2026-09")).toBe(true);
    expect(belongsToMonth(posted, "2026-09", "2026-08")).toBe(false); // reabrieron septiembre
    expect(belongsToMonth(posted, "2026-11", "2026-10")).toBe(false);
    const pending = { postedMonth: null, fiscalMonth: "2026-09" };
    expect(belongsToMonth(pending, "2026-09", null)).toBe(true);
    expect(belongsToMonth(pending, "2026-10", null)).toBe(false);
    expect(belongsToMonth(pending, "2026-10", "2026-09")).toBe(true);
  });

  it("estado para la pantalla: contabilizada, pendiente, o pendiente con el mes fiscal cerrado", () => {
    expect(creditNoteAccountingStatus({ postedMonth: "2026-10", fiscalMonth: "2026-09", closedThrough: "2026-10" })).toEqual({
      status: "posted",
      month: "2026-10",
    });
    expect(creditNoteAccountingStatus({ postedMonth: null, fiscalMonth: "2026-10", closedThrough: "2026-09" })).toEqual({
      status: "pending",
      month: "2026-10",
    });
    expect(creditNoteAccountingStatus({ postedMonth: null, fiscalMonth: "2026-09", closedThrough: "2026-09" })).toEqual({
      status: "pending_closed",
      month: "2026-10",
      fiscalMonth: "2026-09",
    });
  });
});

describe("allocateReceivable — cartera de crédito de cliente", () => {
  it("cancela hasta el saldo pendiente de los cargos de la cuenta, en orden", () => {
    expect(allocateReceivable(100_000, [{ id: "c1", outstandingCents: 60_000 }, { id: "c2", outstandingCents: 70_000 }])).toEqual({
      receivableCents: 100_000,
      perCharge: [
        { id: "c1", cents: 60_000 },
        { id: "c2", cents: 40_000 },
      ],
    });
  });
  it("si el cliente ya pagó la cuenta no hay cartera que bajar; lo pagado de más no cuenta", () => {
    expect(allocateReceivable(100_000, [{ id: "c1", outstandingCents: 0 }])).toEqual({ receivableCents: 0, perCharge: [] });
    expect(allocateReceivable(100_000, [{ id: "c1", outstandingCents: 30_000 }])).toEqual({
      receivableCents: 30_000,
      perCharge: [{ id: "c1", cents: 30_000 }],
    });
    expect(allocateReceivable(100_000, [])).toEqual({ receivableCents: 0, perCharge: [] });
  });
});

describe("matchOrderNotesAndRefunds — notas y reembolsos del mismo pedido", () => {
  const t = (iso: string) => new Date(iso);

  it("reembolso POSTERIOR a la nota: cancela el pasivo de la nota hasta su total", () => {
    const m = matchOrderNotesAndRefunds(
      [{ id: "n1", at: t("2026-09-10T15:00:00Z"), availableCents: 119_000 }],
      [{ id: "r1", at: t("2026-09-12T15:00:00Z"), amountCents: 150_000 }],
    );
    expect(m.notes.get("n1")).toEqual({ coveredByPriorRefundsCents: 0, liabilityCents: 119_000 });
    expect(m.refunds.get("r1")).toEqual({ liabilityDebitCents: 119_000, coveredByLaterNoteCents: 0 });
    expect(refundLinkedCents(m, "r1")).toBe(119_000);
  });

  it("reembolso ANTERIOR a la nota: la nota no repite esa parte (ya es devolución)", () => {
    const m = matchOrderNotesAndRefunds(
      [{ id: "n1", at: t("2026-09-12T15:00:00Z"), availableCents: 119_000 }],
      [{ id: "r1", at: t("2026-09-10T15:00:00Z"), amountCents: 50_000 }],
    );
    expect(m.notes.get("n1")).toEqual({ coveredByPriorRefundsCents: 50_000, liabilityCents: 69_000 });
    expect(m.refunds.get("r1")).toEqual({ liabilityDebitCents: 0, coveredByLaterNoteCents: 50_000 });
  });

  it("dos reembolsos parciales después de la nota consumen el pasivo en orden", () => {
    const m = matchOrderNotesAndRefunds(
      [{ id: "n1", at: t("2026-09-10T15:00:00Z"), availableCents: 100_000 }],
      [
        { id: "r2", at: t("2026-09-20T15:00:00Z"), amountCents: 70_000 },
        { id: "r1", at: t("2026-09-11T15:00:00Z"), amountCents: 60_000 },
      ],
    );
    expect(m.refunds.get("r1")!.liabilityDebitCents).toBe(60_000);
    expect(m.refunds.get("r2")!.liabilityDebitCents).toBe(40_000);
  });

  it("lo que cancela cartera (available = total − receivable) no queda como pasivo", () => {
    const m = matchOrderNotesAndRefunds(
      [{ id: "n1", at: t("2026-09-10T15:00:00Z"), availableCents: 0 }],
      [{ id: "r1", at: t("2026-09-12T15:00:00Z"), amountCents: 10_000 }],
    );
    expect(m.notes.get("n1")).toEqual({ coveredByPriorRefundsCents: 0, liabilityCents: 0 });
    expect(m.refunds.get("r1")!.liabilityDebitCents).toBe(0);
  });
});

describe("creditNotePosting — aporte de una nota al asiento", () => {
  const slices = [
    { kind: "iva" as const, pct: 19, baseCents: 100_000, taxCents: 19_000, grossCents: 119_000 },
  ];
  it("sin cartera ni reembolsos previos: todo al pasivo «reintegros por pagar»", () => {
    expect(creditNotePosting({ id: "n", slices, totalCents: 119_000, receivableCents: 0, coveredByPriorRefundsCents: 0 })).toEqual({
      id: "n",
      slices,
      receivableCents: 0,
      liabilityCents: 119_000,
    });
  });
  it("con cartera: Clientes por lo que canceló y el pasivo por el resto; cuadra", () => {
    const p = creditNotePosting({ id: "n", slices, totalCents: 119_000, receivableCents: 50_000, coveredByPriorRefundsCents: 0 });
    expect(p).toMatchObject({ receivableCents: 50_000, liabilityCents: 69_000 });
    expect(p.slices.reduce((s, x) => s + x.grossCents, 0)).toBe(p.receivableCents + p.liabilityCents);
  });
  it("cubierta por un reembolso anterior: sólo asienta lo que el reembolso no cubrió", () => {
    const p = creditNotePosting({ id: "n", slices, totalCents: 119_000, receivableCents: 0, coveredByPriorRefundsCents: 119_000 });
    expect(p).toEqual({ id: "n", slices: [], receivableCents: 0, liabilityCents: 0 });
  });
});
