import { describe, expect, it } from "vitest";
import { aggregateDocumentTaxes, type PurchaseTaxInput, type SaleTaxInput } from "./taxesDocuments";
import { buildTaxTrend, previousDelta, tileValue, trendPeriods } from "./taxesTrend";

describe("trendPeriods", () => {
  it("meses: los cinco anteriores y el actual", () => {
    expect(trendPeriods({ desde: "2026-10-01", hasta: "2026-10-31" }).map((p) => p.desde)).toEqual([
      "2026-05-01",
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
      "2026-09-01",
      "2026-10-01",
    ]);
    expect(trendPeriods({ desde: "2026-03-01", hasta: "2026-03-31" })[0]).toEqual({ desde: "2025-10-01", hasta: "2025-10-31" });
  });
  it("semanas y años", () => {
    const weeks = trendPeriods({ desde: "2026-10-26", hasta: "2026-11-01" });
    expect(weeks[4]).toEqual({ desde: "2026-10-19", hasta: "2026-10-25" });
    expect(weeks[0]).toEqual({ desde: "2026-09-21", hasta: "2026-09-27" });
    expect(trendPeriods({ desde: "2026-01-01", hasta: "2026-12-31" })[0]).toEqual({ desde: "2021-01-01", hasta: "2021-12-31" });
  });
  it("rango libre: rangos contiguos de la misma cantidad de días", () => {
    const r = trendPeriods({ desde: "2026-10-11", hasta: "2026-10-20" }, 3);
    expect(r).toEqual([
      { desde: "2026-09-21", hasta: "2026-09-30" },
      { desde: "2026-10-01", hasta: "2026-10-10" },
      { desde: "2026-10-11", hasta: "2026-10-20" },
    ]);
  });
});

describe("buildTaxTrend", () => {
  const sale = (id: string, day: string, tax: number): SaleTaxInput => ({
    invoiceId: id,
    document: "",
    dateIso: `${day}T23:30:00.000Z`,
    taxKind: "inc",
    taxPct: 8,
    baseCents: tax * 12.5,
    taxCents: tax,
    customer: null,
  });
  const p: PurchaseTaxInput = {
    purchaseId: "p",
    document: "OC-1",
    dateIso: "2026-10-31T23:59:00.000Z",
    supplierName: "x",
    supplierTaxId: null,
    lines: [],
    incCents: 0,
    retefuenteCents: 700,
    reteIvaCents: 0,
    reteIcaCents: 0,
  };
  const sales = [sale("1", "2026-09-30", 1_000), sale("2", "2026-10-01", 2_000), sale("3", "2026-10-31", 3_000)];
  const periods = trendPeriods({ desde: "2026-10-01", hasta: "2026-10-31" }, 2);

  it("cada período es el documental de ese período (el último = la tesela)", () => {
    const t = buildTaxTrend({
      buckets: periods.map((period, i) => ({ period, refundsCents: i === 1 ? 1_080 : 0 })),
      sales,
      purchases: [p],
      creditNotes: [],
      currentTax: { kind: "inc", pct: 8 },
    });
    expect(t.series.inc).toEqual([1_000, 5_000 - 80]);
    expect(t.series.retefuente).toEqual([0, 700]);
    const october = aggregateDocumentTaxes({
      sales: sales.slice(1),
      purchases: [p],
      refundsCents: 1_080,
      currentTax: { kind: "inc", pct: 8 },
    });
    for (const k of ["inc", "iva", "retefuente", "reteiva", "reteica"] as const) {
      expect(t.series[k][1]).toBe(tileValue(october.totals, k));
    }
  });
});

describe("previousDelta", () => {
  it("contra el período anterior", () => {
    expect(previousDelta([100, 150])).toEqual({ previousCents: 100, deltaCents: 50, deltaPct: 50 });
    expect(previousDelta([-200, -100])).toEqual({ previousCents: -200, deltaCents: 100, deltaPct: 50 });
    expect(previousDelta([0, 150])).toEqual({ previousCents: 0, deltaCents: 150, deltaPct: null });
    expect(previousDelta([150])).toBeNull();
  });
});
