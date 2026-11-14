import { describe, expect, it } from "vitest";
import {
  applyTaxColumns,
  columnLineAmounts,
  invoiceReconcileRows,
  lineArithmetic,
  resolveTaxColumns,
  suggestedRoundingCents,
  taxColumnNeedsReview,
  type ReconcileDocument,
  type ReconcileLine,
  type TaxCell,
} from "./invoiceReconcile";

// Factura SINTÉTICA con la misma estructura que las de un distribuidor de
// licores: Cant. | Vlr. Unitario | IVA % | IVA (Unitario) | ICO | Vlr. Total,
// y pie Subtotal / Descuentos / IVA / ICO / − Retefuente / Ajustes / Total.
// El ICO es un valor POR UNIDAD aunque el encabezado no lo diga.
const money = (cents: number): TaxCell => ({ cents, pct: null });
const pct = (value: number): TaxCell => ({ cents: null, pct: value });
type Row = [qty: number, unit: number, ivaUnit: number, ico: number, total: number];
const ROWS: Row[] = [
  [3, 4_533_330, 226_667, 3_125_000, 13_599_990],
  [2, 3_812_050, 190_603, 2_210_000, 7_624_100],
  [6, 2_745_000, 137_250, 864_000, 16_470_000],
  [1, 6_180_040, 309_002, 1_998_000, 6_180_040],
];
const line = ([quantity, unit, ivaUnit, ico, total]: Row, fields: Partial<ReconcileLine> = {}): ReconcileLine => ({
  quantity, unitPriceCents: unit, lineTotalCents: total, taxPct: "5.00",
  lineTaxCell: money(ivaUnit), lineIncCell: money(ico), ...fields,
});
const LIQUOR: ReconcileDocument = {
  lines: ROWS.map(row => line(row)),
  invoiceSubtotalCents: 43_874_130,
  invoiceDiscountCents: null,
  invoiceTaxCents: 2_193_707,
  invoiceIncCents: 20_977_000,
  retefuenteCents: 1_096_853,
  invoiceAdjustmentCents: 16,
  invoiceTotalCents: 65_948_000,
};
const AI_WRONG = {
  iva: { header: "IVA (Unitario)", scope: "unit" as const, evidence: "El encabezado dice unitario" },
  consumo: { header: "ICO", scope: "line" as const, evidence: "Columna junto al total" },
};

describe("tax column scope: per unit vs line total vs percent", () => {
  it("corrects an ICO read as line total when the footer proves it is per unit", () => {
    const columns = resolveTaxColumns(LIQUOR, AI_WRONG);
    expect(columns.consumo).toMatchObject({ status: "matched", scope: "unit", candidates: ["unit"],
      printedCents: 20_977_000, computedCents: 20_977_000, aiScope: "line" });
    expect(columns.iva).toMatchObject({ status: "matched", scope: "unit", computedCents: 2_193_707 });
    const lines = applyTaxColumns(LIQUOR, { iva: columns.iva!.scope, consumo: columns.consumo!.scope });
    expect(lines.map(l => l.lineIncCents)).toEqual([9_375_000, 4_420_000, 5_184_000, 1_998_000]);
    expect(lines.every(l => !l.lineIncAmbiguous)).toBe(true);
    // IVA (Unitario) × cantidad da 2 centavos de más por redondeo; la tarifa
    // de cada línea da el IVA del pie al centavo y es la que se guarda.
    expect(lines.map(l => l.lineTaxCents)).toEqual([680_000, 381_205, 823_500, 309_002]);
    expect(lines.reduce((sum, l) => sum + l.lineTaxCents!, 0)).toBe(2_193_707);
    expect(taxColumnNeedsReview(columns.consumo)).toBe(false);
    expect(taxColumnNeedsReview(columns.iva)).toBe(false);
  });

  it("keeps the printed value when the column already holds the line total", () => {
    const doc = { ...LIQUOR, lines: ROWS.map(row => line(row, { lineIncCell: money(row[3] * row[0]),
      lineTaxCell: money(Math.round(row[4] * 0.05)) })) };
    const columns = resolveTaxColumns(doc, { consumo: { header: "ICO total", scope: "unit", evidence: null } });
    expect(columns.consumo).toMatchObject({ status: "matched", scope: "line", computedCents: 20_977_000 });
    expect(columns.iva).toMatchObject({ status: "matched", scope: "line" });
    expect(applyTaxColumns(doc, { iva: "line", consumo: "line" }).map(l => l.lineIncCents))
      .toEqual([9_375_000, 4_420_000, 5_184_000, 1_998_000]);
  });

  it("reads a consumption column printed as a percentage of the line base", () => {
    const lines = ROWS.map(row => line(row, { lineIncCell: pct(8), lineTaxCell: null }));
    const inc = ROWS.reduce((sum, row) => sum + Math.round(row[4] * 0.08), 0);
    const doc: ReconcileDocument = { lines, invoiceSubtotalCents: 43_874_130, invoiceTaxCents: 2_193_707,
      invoiceIncCents: inc, invoiceTotalCents: 43_874_130 + 2_193_707 + inc };
    const columns = resolveTaxColumns(doc, {});
    expect(columns.consumo).toMatchObject({ status: "matched", scope: "percent", options: ["percent"] });
    expect(columns.iva).toBeNull();
    expect(applyTaxColumns(doc, { iva: null, consumo: "percent" }).map(l => l.lineIncCents))
      .toEqual(ROWS.map(row => Math.round(row[4] * 0.08)));
  });

  it("resolves both columns against the grand total when the footer omits the taxes", () => {
    const doc = { ...LIQUOR, invoiceTaxCents: null, invoiceIncCents: null };
    const columns = resolveTaxColumns(doc, { consumo: { header: "ICO", scope: "unknown", evidence: null } });
    expect(columns.consumo).toMatchObject({ status: "matched", scope: "unit" });
    // Without a printed IVA, its own rate per line decides the IVA column.
    expect(columns.iva).toMatchObject({ status: "matched", scope: "unit" });
  });

  it("leaves an invoice with neither tax footer nor total for review, preselecting the AI reading", () => {
    const doc: ReconcileDocument = { lines: ROWS.map(row => line(row, { lineTaxCell: null })) };
    const columns = resolveTaxColumns(doc, AI_WRONG);
    expect(columns.consumo).toMatchObject({ status: "unverified", scope: "line" });
    expect(taxColumnNeedsReview(columns.consumo)).toBe(true);
    const unknown = resolveTaxColumns(doc, {});
    expect(unknown.consumo).toMatchObject({ status: "unverified", scope: null });
    const lines = applyTaxColumns(doc, { iva: null, consumo: null });
    expect(lines.map(l => [l.lineIncCents, l.lineIncAmbiguous])).toEqual(ROWS.map(() => [null, true]));
  });

  it("reconciles a supplier discount: subtotal before discounts, ICO per unit", () => {
    const discounted = ROWS.map(([qty, unit, , ico, total]) => {
      const discount = Math.round(total * 0.1);
      return line([qty, unit, 0, ico, total - discount], { lineDiscountCents: discount, lineTaxCell: null, taxPct: "0" });
    });
    const net = ROWS.reduce((sum, row) => sum + row[4] - Math.round(row[4] * 0.1), 0);
    const discount = ROWS.reduce((sum, row) => sum + Math.round(row[4] * 0.1), 0);
    const doc: ReconcileDocument = { lines: discounted, invoiceSubtotalCents: 43_874_130, invoiceDiscountCents: discount,
      invoiceTotalCents: net + 20_977_000 };
    expect(net + discount).toBe(43_874_130);
    const columns = resolveTaxColumns(doc, { consumo: { header: "ICO", scope: "line", evidence: null } });
    expect(columns.consumo).toMatchObject({ status: "matched", scope: "unit" });
    expect(discounted.map(l => lineArithmetic(l, 0, 0).status)).toEqual(["consistent", "consistent", "consistent", "consistent"]);
  });

  it("does not guess when two different readings both fit inside rounding", () => {
    // Consumo de pocos centavos por unidad: unidad y total de línea quedan
    // dentro del redondeo del pie. No se elige en silencio.
    const lines = [line([2, 100_000, 0, 10, 200_000], { lineTaxCell: null, taxPct: "0" }),
      line([3, 50_000, 0, 20, 150_000], { lineTaxCell: null, taxPct: "0" })];
    const doc: ReconcileDocument = { lines, invoiceIncCents: 70, invoiceSubtotalCents: 350_000 };
    const columns = resolveTaxColumns(doc, {});
    expect(columns.consumo?.status).toBe("ambiguous");
    expect(columns.consumo?.candidates).toEqual(["unit", "line"]);
    expect(taxColumnNeedsReview(columns.consumo)).toBe(true);
  });

  it("marks a column whose readings never match the footer as a mismatch with the exact difference", () => {
    const doc = { ...LIQUOR, invoiceIncCents: 20_000_000 };
    const columns = resolveTaxColumns(doc, { consumo: { header: "ICO", scope: "unknown", evidence: null } });
    expect(columns.consumo).toMatchObject({ status: "mismatch", scope: "unit", candidates: [] });
    expect(columns.consumo!.printedCents! - columns.consumo!.computedCents!).toBe(-977_000);
  });

  it("does not ask for review when every reading gives the same amounts", () => {
    const lines = ROWS.map(([, unit, ivaUnit, ico]) => line([1, unit, ivaUnit, ico, unit]));
    const columns = resolveTaxColumns({ lines }, {});
    expect(columns.consumo).toMatchObject({ status: "equivalent" });
    expect(taxColumnNeedsReview(columns.consumo)).toBe(false);
  });

  it("flags unreadable cells for that line only", () => {
    const lines = [...LIQUOR.lines.slice(0, 3), { ...LIQUOR.lines[3]!, lineIncCell: { cents: null, pct: null, invalid: true } }];
    const columns = resolveTaxColumns({ ...LIQUOR, lines }, AI_WRONG);
    expect(columns.consumo?.status).toBe("unverified");
    const applied = applyTaxColumns({ ...LIQUOR, lines }, { iva: "unit", consumo: "unit" });
    expect(applied.map(l => l.lineIncAmbiguous)).toEqual([false, false, false, true]);
  });

  it("gives the same per-line amounts to the review control as to the reader", () => {
    expect(columnLineAmounts(LIQUOR, "consumo", "line")).toEqual([3_125_000, 2_210_000, 864_000, 1_998_000]);
    expect(columnLineAmounts(LIQUOR, "consumo", "unit")).toEqual([9_375_000, 4_420_000, 5_184_000, 1_998_000]);
  });
});

describe("line arithmetic", () => {
  it("accepts quantity × unit = total within the rounding of the printed unit price", () => {
    expect(lineArithmetic(line(ROWS[0]!), null, null)).toEqual({ status: "consistent", diffCents: 0 });
    // Unit printed in whole pesos: 3 × $33.333 vs a total computed from $33.333,33.
    expect(lineArithmetic({ quantity: 3, unitPriceCents: 3_333_300, lineTotalCents: 10_000_000 }, null, null).status)
      .toBe("consistent");
  });

  it("detects a line total that already includes IVA and consumption", () => {
    expect(lineArithmetic({ quantity: 2, unitPriceCents: 4_241_700, lineTotalCents: 13_885_000 }, 424_200, 4_977_400))
      .toEqual({ status: "taxes_included", diffCents: 0 });
  });

  it("reports the exact difference of a line that does not add up", () => {
    expect(lineArithmetic({ quantity: 2, unitPriceCents: 100_000, lineTotalCents: 250_000 }, null, null))
      .toEqual({ status: "mismatch", diffCents: 50_000 });
  });
});

describe("invoice vs MESAPAY summary", () => {
  const computed = {
    listSubtotalCents: 43_874_130, netSubtotalCents: 43_874_130, discountCents: 0,
    ivaCents: 2_193_707, incCents: 20_977_000, retentionsCents: 1_096_853,
    adjustmentCents: 16, totalCents: 65_948_000,
  };
  const printed = {
    subtotalCents: 43_874_130, discountCents: null, ivaCents: 2_193_707, incCents: 20_977_000,
    retentionsCents: 1_096_853, adjustmentCents: 16, totalCents: 65_948_000,
  };

  it("matches every footer row to the cent, rounding included as its own row", () => {
    const summary = invoiceReconcileRows(printed, computed);
    expect(summary.hasDifferences).toBe(false);
    expect(summary.rows.map(r => r.key)).toEqual(["subtotal", "iva", "consumo", "retentions", "adjustment", "total"]);
    expect(summary.rows.every(r => r.diffCents === 0)).toBe(true);
  });

  it("shows the exact difference per row instead of hiding it", () => {
    const summary = invoiceReconcileRows(printed, { ...computed, incCents: 8_197_000, adjustmentCents: 0,
      totalCents: 65_948_000 - 12_780_000 - 16 });
    expect(summary.hasDifferences).toBe(true);
    expect(summary.rows.find(r => r.key === "consumo")?.diffCents).toBe(12_780_000);
    expect(summary.rows.find(r => r.key === "adjustment")?.diffCents).toBe(16);
    expect(summary.rows.find(r => r.key === "total")?.diffCents).toBe(12_780_016);
  });

  it("compares a subtotal printed after discounts with the discounted base", () => {
    const summary = invoiceReconcileRows({ subtotalCents: 90_000, discountCents: 10_000, totalCents: 90_000 },
      { ...computed, listSubtotalCents: 100_000, netSubtotalCents: 90_000, discountCents: 10_000, ivaCents: 0,
        incCents: 0, retentionsCents: 0, adjustmentCents: 0, totalCents: 90_000 });
    expect(summary.rows.find(r => r.key === "subtotal")).toMatchObject({ computedCents: 90_000, diffCents: 0 });
    expect(summary.hasDifferences).toBe(false);
  });

  it("suggests a rounding adjustment only for a small difference, never spread over the lines", () => {
    expect(suggestedRoundingCents(65_948_000, 65_947_984)).toBe(16);
    expect(suggestedRoundingCents(65_948_000, 65_948_032)).toBe(-32);
    expect(suggestedRoundingCents(65_948_000, 65_948_000)).toBeNull();
    expect(suggestedRoundingCents(65_948_000, 52_000_000)).toBeNull();
    expect(suggestedRoundingCents(null, 1)).toBeNull();
  });
});
