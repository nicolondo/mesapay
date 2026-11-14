import { describe, expect, it } from "vitest";
import { line } from "./__fixtures__/supportDoc";
import {
  applyWithholdings,
  draftFromExpense,
  draftFromPurchase,
  generationFormFor,
  ivaPctFor,
  paymentMeansFor,
  proportionalSplit,
  type ExpenseForSupportDoc,
  type PurchaseForSupportDoc,
} from "./source";

// 13-nov-2026, 10:00 en Colombia.
const NOW = new Date("2026-11-13T15:00:00Z");
// Mediodía local de cada día (así guarda la fecha el formulario de gastos).
const day = (d: string) => new Date(`${d}T17:00:00Z`);

const EXPENSE: ExpenseForSupportDoc = {
  id: "e1",
  category: "Mantenimiento",
  description: "Arreglo de la nevera",
  date: day("2026-11-13"),
  amountCents: 1_190_000,
  baseCents: 1_000_000,
  ivaPct: 19,
  ivaCents: 190_000,
  incCents: 0,
  payableCents: 1_136_500,
  paidCents: 0,
  paidAt: null,
  dueAt: day("2026-12-13"),
  documentNumber: "CC-77",
  recurring: false,
  supplier: null,
  retentions: [
    { kind: "retefuente", rateBps: 250, baseCents: 1_000_000, amountCents: 25_000 },
    { kind: "reteiva", rateBps: 1500, baseCents: 190_000, amountCents: 28_500 },
    { kind: "reteica", rateBps: 966, baseCents: 1_000_000, amountCents: 966 },
  ],
};

describe("forma de generación (tabla 16.1.6, DSFC02)", () => {
  it("mismo día → por operación; hasta 6 días → acumulado semanal", () => {
    expect(generationFormFor("2026-11-13", "2026-11-13")).toBe("1");
    expect(generationFormFor("2026-11-12", "2026-11-13")).toBe("2");
    expect(generationFormFor("2026-11-07", "2026-11-13")).toBe("2");
  });
  it("más de 6 días o en el futuro: no se puede transmitir", () => {
    expect(() => generationFormFor("2026-11-06", "2026-11-13")).toThrow("operation_too_old");
    expect(() => generationFormFor("2026-11-14", "2026-11-13")).toThrow("operation_in_future");
  });
});

describe("gasto → documento soporte", () => {
  it("una línea con la base, el IVA y las retenciones que permite el anexo", () => {
    const d = draftFromExpense(EXPENSE, NOW);
    expect(d.operationDate).toBe("2026-11-13");
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({
      description: "Arreglo de la nevera",
      lineTotalCents: 1_000_000,
      ivaCents: 190_000,
      ivaPct: "19.00",
      generationForm: "1",
      purchaseDate: "2026-11-13",
    });
    expect(d.lines[0].withholdings).toEqual([
      { schemeId: "06", taxableCents: 1_000_000, amountCents: 25_000, pct: "2.50" },
      { schemeId: "05", taxableCents: 190_000, amountCents: 28_500, pct: "15.00" },
    ]);
    // ReteICA no existe en la tabla 16.2.2: queda registrada fuera del XML.
    expect(d.untransmittedWithholdings).toEqual([{ kind: "reteica", amountCents: 966, reason: "not_in_annex" }]);
    // Con saldo y vencimiento: crédito.
    expect(d.paymentMeans).toEqual({ id: "2", code: "1", dueDate: "2026-12-13" });
  });

  it("gasto de hace 3 días → acumulado semanal con la fecha real de la compra", () => {
    const d = draftFromExpense({ ...EXPENSE, date: day("2026-11-10") }, NOW);
    expect(d.lines[0]).toMatchObject({ generationForm: "2", purchaseDate: "2026-11-10" });
  });

  it("bloquea lo que el DS no admite", () => {
    expect(() => draftFromExpense({ ...EXPENSE, incCents: 8_000 }, NOW)).toThrow("inc_not_supported");
    expect(() => draftFromExpense({ ...EXPENSE, recurring: true }, NOW)).toThrow("source_not_ready");
    expect(() => draftFromExpense({ ...EXPENSE, ivaCents: 50_000 }, NOW)).toThrow("iva_mismatch");
  });

  it("gasto viejo sin base (base = valor) y sin descripción usa la categoría", () => {
    const d = draftFromExpense(
      { ...EXPENSE, description: null, baseCents: 0, ivaCents: 0, ivaPct: 0, retentions: [], paidCents: 500_000, payableCents: 0, amountCents: 500_000 },
      NOW,
    );
    expect(d.lines[0]).toMatchObject({ description: "Mantenimiento", lineTotalCents: 500_000, ivaPct: "0.00" });
    expect(d.paymentMeans).toEqual({ id: "1", code: "1", dueDate: null });
  });

  it("una retención cuyo valor no es base × tarifa no viaja (DSAT07) y se dice", () => {
    const d = draftFromExpense(
      { ...EXPENSE, retentions: [{ kind: "retefuente", rateBps: 250, baseCents: 1_000_000, amountCents: 30_000 }] },
      NOW,
    );
    expect(d.lines[0].withholdings).toEqual([]);
    expect(d.untransmittedWithholdings).toEqual([{ kind: "retefuente", amountCents: 30_000, reason: "rate_mismatch" }]);
  });
});

describe("compra recibida → documento soporte", () => {
  const PO: PurchaseForSupportDoc = {
    id: "p1",
    number: 7,
    status: "received",
    supplierInvoiceNumber: "CC-12",
    receivedAt: day("2026-11-12"),
    createdAt: day("2026-11-01"),
    invoiceDueAt: null,
    paidAt: day("2026-11-12"),
    incCents: 0,
    retefuenteCents: 37_500,
    reteIvaCents: 0,
    reteIcaCents: 0,
    supplier: null,
    items: [
      { id: "i1", expectedCostCents: 1_000_000, expectedTaxCents: null, expectedIncCents: 0, qtyOrderedBase: 5000, taxPct: 0, receivedCostCents: 1_000_000, receivedQtyBase: 5000, lastReceivedAt: day("2026-11-12"), ingredient: { name: "Tomate", measureKind: "mass" } },
      { id: "i2", expectedCostCents: 500_000, expectedTaxCents: null, expectedIncCents: 0, qtyOrderedBase: 10, taxPct: 0, receivedCostCents: 500_000, receivedQtyBase: 10, lastReceivedAt: day("2026-11-12"), ingredient: { name: "Huevos", measureKind: "count" } },
      { id: "i3", expectedCostCents: 200_000, expectedTaxCents: null, expectedIncCents: 0, qtyOrderedBase: 3, taxPct: 0, receivedCostCents: 0, receivedQtyBase: 0, lastReceivedAt: null, ingredient: { name: "No llegó", measureKind: "count" } },
    ],
  };

  it("una línea por insumo recibido (cantidad física en la descripción) y la retefuente repartida", () => {
    const d = draftFromPurchase(PO, NOW);
    expect(d.sourceLabel).toBe("OC-0007 · CC-12");
    expect(d.lines.map((l) => [l.description, l.lineTotalCents, l.quantity])).toEqual([
      ["Tomate (5000 g)", 1_000_000, 1],
      ["Huevos (10 un)", 500_000, 1],
    ]);
    expect(d.lines.every((l) => l.generationForm === "2" && l.purchaseDate === "2026-11-12")).toBe(true);
    expect(d.lines.flatMap((l) => l.withholdings)).toEqual([
      { schemeId: "06", taxableCents: 1_000_000, amountCents: 25_000, pct: "2.50" },
      { schemeId: "06", taxableCents: 500_000, amountCents: 12_500, pct: "2.50" },
    ]);
    expect(d.paymentMeans.id).toBe("1");
  });

  it("sólo compras recibidas completas", () => {
    expect(() => draftFromPurchase({ ...PO, status: "partially_received" }, NOW)).toThrow("source_not_ready");
  });
});

describe("helpers", () => {
  it("reparto exacto (resto mayor)", () => {
    expect(proportionalSplit(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(proportionalSplit(10, [0, 0])).toEqual([0, 0]);
  });
  it("tarifa del IVA con tolerancia de ±5 pesos", () => {
    expect(ivaPctFor(1_000_000, 190_000, 19)).toBe("19.00");
    expect(ivaPctFor(1_000_000, 50_000, 0)).toBe("5.00");
    expect(ivaPctFor(1_000_000, 0, 19)).toBe("0.00");
  });
  it("crédito: el vencimiento nunca antes de la emisión", () => {
    expect(paymentMeansFor(false, day("2026-11-01"), "2026-11-13")).toEqual({ id: "2", code: "1", dueDate: "2026-11-13" });
  });
  it("las retenciones se aplican a líneas nuevas sin mutar las de entrada", () => {
    const input = [line()];
    applyWithholdings(input, [{ kind: "retefuente", amountCents: 250_000, rateBps: 250, baseCents: null }]);
    expect(input[0].withholdings).toEqual([]);
  });
});
