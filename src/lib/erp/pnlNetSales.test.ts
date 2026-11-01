// PYG e «Impuestos del mes» netos: los ingresos por ventas son lo cobrado
// sin impuesto ni propina, neto de descuentos, menos las notas crédito
// aceptadas y las devoluciones; el impuesto, bruto − notas − devoluciones.
import { describe, expect, it } from "vitest";
import {
  buildPnl,
  netCategorySales,
  netSalesCents,
  netSalesTaxByRate,
  refundAdjustment,
  type TaxSummary,
} from "./accounting";
import { taxDeclarationFrom } from "./fiscal";

describe("netSalesCents", () => {
  it("resta descuento, impuesto incluido, notas crédito y devoluciones del precio de carta", () => {
    expect(
      netSalesCents({
        listCents: 1_080_000,
        discountCents: 54_000,
        includedTaxCents: 80_000,
        creditNotesCents: 100_000,
        refundsCents: 20_000,
      }),
    ).toBe(826_000);
  });

  it("buildPnl calcula los márgenes sobre los ingresos netos y conserva el detalle", () => {
    const detail = {
      listCents: 108_000,
      discountCents: 0,
      includedTaxCents: 8_000,
      creditNotesCents: 0,
      refundsCents: 0,
    };
    const pnl = buildPnl({
      salesCents: netSalesCents(detail),
      salesDetail: detail,
      tipsCents: 5_000,
      taxesCents: 0,
      consumptionCents: 30_000,
      wasteCents: 0,
      expensesByCategory: [],
      purchasesReceivedCents: 0,
    });
    expect(pnl.salesCents).toBe(100_000);
    expect(pnl.grossProfitCents).toBe(70_000);
    expect(pnl.grossMarginPct).toBe(70);
    expect(pnl.salesDetail).toEqual(detail);
  });
});

describe("netCategorySales", () => {
  it("reparte descuento por precio de carta e impuesto sólo sobre platos de carta, y cuadra al centavo", () => {
    const net = netCategorySales(
      [
        { category: "Platos", listCents: 75_600, menuListCents: 75_600 },
        { category: "Bebidas", listCents: 32_400, menuListCents: 32_400 },
        // Línea libre: el impuesto va encima, no adentro.
        { category: "(sin categoría)", listCents: 10_000, menuListCents: 0 },
      ],
      { discountCents: 11_800, includedTaxCents: 8_000 },
    );
    const total = [...net.values()].reduce((s, v) => s + v, 0);
    expect(total).toBe(118_000 - 11_800 - 8_000);
    // La línea libre sólo absorbe su parte del descuento.
    expect(net.get("(sin categoría)")).toBe(9_000);
    expect(net.get("Platos")).toBe(75_600 - 7_560 - 5_600);
    expect(net.get("Bebidas")).toBe(32_400 - 3_240 - 2_400);
  });

  it("sin ventas devuelve ceros", () => {
    const net = netCategorySales([{ category: "(otros)", listCents: 0, menuListCents: 0 }], {
      discountCents: 0,
      includedTaxCents: 0,
    });
    expect(net.get("(otros)")).toBe(0);
  });
});

describe("netSalesTaxByRate / refundAdjustment", () => {
  it("la devolución sin nota se estima embebida en el tramo del mes", () => {
    expect(refundAdjustment(108_000, { kind: "inc", pct: 8 })).toEqual({
      grossCents: 108_000,
      baseCents: 100_000,
      taxCents: 8_000,
    });
    expect(refundAdjustment(50_000, { kind: "none", pct: 0 })).toEqual({
      grossCents: 50_000,
      baseCents: 50_000,
      taxCents: 0,
    });
  });

  it("cada nota resta en la tarifa de sus líneas; la devolución, en el tramo del mes", () => {
    const net = netSalesTaxByRate(
      [
        { kind: "inc", pct: 8, taxCents: 80_000 },
        { kind: "iva", pct: 19, taxCents: 19_000 },
      ],
      [
        { kind: "iva", pct: 19, taxCents: 1_900 },
        { kind: "none", pct: 0, taxCents: 0 },
      ],
      { kind: "inc", pct: 8, taxCents: 800 },
    );
    expect(net).toEqual([
      { kind: "iva", pct: 19, grossTaxCents: 19_000, creditNoteTaxCents: 1_900, refundTaxCents: 0, taxCents: 17_100 },
      { kind: "inc", pct: 8, grossTaxCents: 80_000, creditNoteTaxCents: 0, refundTaxCents: 800, taxCents: 79_200 },
    ]);
  });
});

function summary(over: Partial<TaxSummary["sales"]>): TaxSummary {
  return {
    sales: {
      kind: "inc",
      pct: 8,
      grossCents: 0,
      taxCents: 0,
      baseCents: 0,
      byRate: [],
      creditNotes: { count: 0, grossCents: 0, baseCents: 0, taxCents: 0 },
      refunds: { grossCents: 0, baseCents: 0, taxCents: 0 },
      net: { baseCents: 0, taxCents: 0, byRate: [] },
      ...over,
    },
    purchases: { ivaCents: 5_000, incCents: 0, retefuenteCents: 0, reteIvaCents: 0, reteIcaCents: 0 },
  };
}

describe("taxDeclarationFrom («Impuestos del mes»)", () => {
  it("INC: el generado y lo que se paga son netos de notas crédito y devoluciones", () => {
    const d = taxDeclarationFrom(
      summary({
        net: {
          baseCents: 900_000,
          taxCents: 72_000,
          byRate: [
            { kind: "inc", pct: 8, grossTaxCents: 80_000, creditNoteTaxCents: 7_200, refundTaxCents: 800, taxCents: 72_000 },
          ],
        },
      }),
    );
    expect(d).toMatchObject({
      salesBaseCents: 900_000,
      incGeneradoBrutoCents: 80_000,
      incNotasCreditoCents: 7_200,
      incDevolucionesCents: 800,
      incGeneradoCents: 72_000,
      incAPagarCents: 72_000,
    });
  });

  it("IVA: el descontable se cruza contra el generado NETO", () => {
    const d = taxDeclarationFrom(
      summary({
        kind: "iva",
        pct: 19,
        net: {
          baseCents: 0,
          taxCents: 17_100,
          byRate: [
            { kind: "iva", pct: 19, grossTaxCents: 19_000, creditNoteTaxCents: 1_900, refundTaxCents: 0, taxCents: 17_100 },
          ],
        },
      }),
    );
    expect(d.ivaGeneradoBrutoCents).toBe(19_000);
    expect(d.ivaNotasCreditoCents).toBe(1_900);
    expect(d.ivaGeneradoCents).toBe(17_100);
    expect(d.ivaAPagarCents).toBe(17_100 - 5_000);
  });

  it("un neto negativo no se paga: queda en cero (saldo a favor para el contador)", () => {
    const d = taxDeclarationFrom(
      summary({
        net: {
          baseCents: -100_000,
          taxCents: -8_000,
          byRate: [
            { kind: "inc", pct: 8, grossTaxCents: 0, creditNoteTaxCents: 8_000, refundTaxCents: 0, taxCents: -8_000 },
          ],
        },
      }),
    );
    expect(d.incGeneradoCents).toBe(-8_000);
    expect(d.incAPagarCents).toBe(0);
  });
});
