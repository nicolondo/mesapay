import { describe, expect, it } from "vitest";
import {
  aggregateDocumentTaxes,
  documentFamilies,
  dominantSalesTax,
  type PurchaseTaxInput,
  type SaleTaxInput,
} from "./taxesDocuments";

const sale = (
  id: string,
  taxKind: SaleTaxInput["taxKind"],
  taxPct: number,
  baseCents: number,
  taxCents: number,
): SaleTaxInput => ({
  invoiceId: id,
  document: `FESM${id}`,
  dateIso: "2026-08-10T15:00:00.000Z",
  taxKind,
  taxPct,
  baseCents,
  taxCents,
  customer: null,
});

const purchase = (
  id: string,
  lines: PurchaseTaxInput["lines"],
  header: Partial<Pick<PurchaseTaxInput, "incCents" | "retefuenteCents" | "reteIvaCents" | "reteIcaCents">> = {},
): PurchaseTaxInput => ({
  purchaseId: id,
  document: `OC-${id}`,
  dateIso: "2026-08-12T00:00:00.000Z",
  supplierName: "Proveedor",
  supplierTaxId: "900123456",
  lines,
  incCents: 0,
  retefuenteCents: 0,
  reteIvaCents: 0,
  reteIcaCents: 0,
  ...header,
});

describe("aggregateDocumentTaxes — ventas por kind:tarifa", () => {
  it("agrupa lo que cada factura congeló, por tipo y tarifa, y suma totales", () => {
    const docs = aggregateDocumentTaxes({
      sales: [
        sale("1", "inc", 8, 100_000, 8_000),
        sale("2", "inc", 8, 50_000, 4_000),
        sale("3", "iva", 19, 200_000, 38_000),
        sale("4", "none", 0, 30_000, 0), // sin impuesto: no aparece
      ],
      purchases: [],
    });
    expect(docs.sales.map((b) => [b.key, b.baseCents, b.taxCents])).toEqual([
      ["iva:19", 200_000, 38_000],
      ["inc:8", 150_000, 12_000],
    ]);
    expect(docs.totals.ivaGeneradoCents).toBe(38_000);
    expect(docs.totals.incGeneradoCents).toBe(12_000);
    expect(docs.totals.generadosCents).toBe(50_000);
    expect(documentFamilies(docs)).toEqual(["iva", "inc"]);
  });

  it("un comercio que cambió de tarifa a mitad de mes tiene dos tramos del mismo tipo", () => {
    const docs = aggregateDocumentTaxes({
      sales: [sale("1", "iva", 19, 100_000, 19_000), sale("2", "iva", 5, 100_000, 5_000)],
      purchases: [],
    });
    expect(docs.sales.map((b) => b.key)).toEqual(["iva:19", "iva:5"]);
  });

  it("las devoluciones restan del tramo dominante con el impuesto embebido, como el asiento refund", () => {
    const docs = aggregateDocumentTaxes({
      sales: [sale("1", "inc", 8, 1_000_000, 80_000)],
      purchases: [],
      refundsCents: 108_000, // bruto devuelto ⇒ 8.000 de INC embebido
    });
    const inc = docs.sales[0]!;
    expect(inc.refundTaxCents).toBe(8_000);
    expect(inc.refundBaseCents).toBe(100_000);
    expect(inc.taxCents).toBe(72_000);
    expect(inc.baseCents).toBe(900_000);
    expect(docs.totals.refundsCents).toBe(108_000);
    expect(docs.totals.refundTaxCents).toBe(8_000);
    expect(docs.totals.incGeneradoCents).toBe(72_000);
  });

  it("sin ventas en el período, las devoluciones usan la tarifa vigente del comercio", () => {
    const docs = aggregateDocumentTaxes({
      sales: [],
      purchases: [],
      refundsCents: 119_000,
      currentTax: { kind: "iva", pct: 19 },
    });
    expect(docs.sales).toEqual([
      expect.objectContaining({ key: "iva:19", taxCents: -19_000, refundTaxCents: 19_000 }),
    ]);
    // Comercio sin impuesto: la devolución no lleva impuesto.
    const none = aggregateDocumentTaxes({ sales: [], purchases: [], refundsCents: 119_000 });
    expect(none.sales).toEqual([]);
    expect(none.totals.refundTaxCents).toBe(0);
  });

  it("dominantSalesTax: el tramo que más impuesto causó, o la configuración actual", () => {
    expect(
      dominantSalesTax(
        [sale("1", "iva", 19, 0, 1_000), sale("2", "inc", 8, 0, 5_000)],
        { kind: "iva", pct: 19 },
      ),
    ).toEqual({ kind: "inc", pct: 8 });
    expect(dominantSalesTax([], { kind: "inc", pct: 8 })).toEqual({ kind: "inc", pct: 8 });
    expect(dominantSalesTax([], { kind: "none", pct: 8 })).toEqual({ kind: "none", pct: 0 });
  });
});

describe("aggregateDocumentTaxes — compras", () => {
  it("IVA por tarifa de las líneas (neto × %), INC de cabecera sin tarifa, retenciones por concepto", () => {
    const docs = aggregateDocumentTaxes({
      sales: [],
      purchases: [
        purchase(
          "1",
          [
            { netCents: 100_000, taxPct: 19, nonDeductibleTaxCents: 0 },
            { netCents: 50_000, taxPct: 5, nonDeductibleTaxCents: 0 },
            { netCents: 20_000, taxPct: 0, nonDeductibleTaxCents: 0 }, // excluido: no aparece
          ],
          { incCents: 3_000, retefuenteCents: 4_250, reteIvaCents: 3_225, reteIcaCents: 1_190 },
        ),
        purchase("2", [{ netCents: 10_000, taxPct: 19, nonDeductibleTaxCents: 1_900 }]),
      ],
    });
    expect(docs.purchases.map((b) => [b.key, b.baseCents, b.taxCents])).toEqual([
      ["iva:19", 110_000, 20_900],
      ["iva:5", 50_000, 2_500],
      ["inc:-", 170_000, 3_000],
    ]);
    expect(docs.totals.ivaComprasCents).toBe(23_400);
    expect(docs.totals.ivaNoDescontableCents).toBe(1_900);
    expect(docs.totals.ivaDescontableCents).toBe(21_500);
    expect(docs.totals.incComprasCents).toBe(3_000);
    expect(docs.retentions.map((b) => [b.key, b.baseCents, b.taxCents])).toEqual([
      ["retefuente:-", 170_000, 4_250],
      ["reteiva:-", 21_500, 3_225],
      ["reteica:-", 170_000, 1_190],
    ]);
    expect(docs.totals.retefuenteCents).toBe(4_250);
    expect(docs.totals.reteIvaCents).toBe(3_225);
    expect(docs.totals.reteIcaCents).toBe(1_190);
    expect(documentFamilies(docs)).toEqual(["iva", "inc"]);
  });

  it("diferencia documental de IVA = generado en ventas − registrado en compras (todo el IVA)", () => {
    const docs = aggregateDocumentTaxes({
      sales: [sale("1", "iva", 19, 500_000, 95_000)],
      purchases: [purchase("1", [{ netCents: 100_000, taxPct: 19, nonDeductibleTaxCents: 5_000 }])],
    });
    expect(docs.ivaDiferenciaDocumentalCents).toBe(95_000 - 19_000);
    expect(docs.totals.ivaDescontableCents).toBe(14_000);
  });

  it("un período vacío devuelve listas vacías y ceros (IVA siempre como familia)", () => {
    const docs = aggregateDocumentTaxes({ sales: [], purchases: [] });
    expect(docs.sales).toEqual([]);
    expect(docs.purchases).toEqual([]);
    expect(docs.retentions).toEqual([]);
    expect(docs.totals.generadosCents).toBe(0);
    expect(docs.ivaDiferenciaDocumentalCents).toBe(0);
    expect(documentFamilies(docs)).toEqual(["iva"]);
  });
});
