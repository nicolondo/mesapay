import { describe, expect, it } from "vitest";
import { buildTaxCross } from "./taxesCross";
import { aggregateDocumentTaxes, type PurchaseTaxInput, type SaleTaxInput } from "./taxesDocuments";
import { buildTaxAccountReport, type TaxAccount, type TaxLedgerLine } from "./taxesModel";

const sales: SaleTaxInput[] = [
  {
    invoiceId: "i1",
    document: "FESM1",
    dateIso: "2026-08-10T15:00:00.000Z",
    taxKind: "iva",
    taxPct: 19,
    baseCents: 1_000_000,
    taxCents: 190_000,
    customer: null,
  },
  {
    invoiceId: "i2",
    document: "FESM2",
    dateIso: "2026-08-11T15:00:00.000Z",
    taxKind: "inc",
    taxPct: 8,
    baseCents: 500_000,
    taxCents: 40_000,
    customer: null,
  },
];

const purchases: PurchaseTaxInput[] = [
  {
    purchaseId: "p1",
    document: "F-77",
    dateIso: "2026-08-12T00:00:00.000Z",
    supplierName: "Proveedor",
    supplierTaxId: "900123456",
    lines: [{ netCents: 300_000, taxPct: 19, nonDeductibleTaxCents: 7_000 }],
    incCents: 0,
    retefuenteCents: 7_500,
    reteIvaCents: 0,
    reteIcaCents: 2_100,
  },
];

const accounts: TaxAccount[] = [
  { code: "24080501", name: "IVA generado 19%", type: "pasivo" },
  { code: "24081001", name: "IVA descontable 19%", type: "pasivo" },
  { code: "241205", name: "INC por pagar (8%)", type: "pasivo" },
  { code: "236505", name: "Retefuente por pagar", type: "pasivo" },
  { code: "236805", name: "ReteICA por pagar", type: "pasivo" },
];

describe("cruce documental vs libro", () => {
  it("IVA se cruza contra el DESCONTABLE (lo que el motor lleva a 2408), no contra todo el IVA de compras", () => {
    // El motor asentó exactamente lo que dicen los documentos.
    const lines: TaxLedgerLine[] = [
      { accountCode: "24080501", debitCents: 0, creditCents: 190_000 },
      { accountCode: "24081001", debitCents: 50_000, creditCents: 0 }, // 57.000 − 7.000 no descontable
      { accountCode: "241205", debitCents: 0, creditCents: 40_000 },
      { accountCode: "236505", debitCents: 0, creditCents: 7_500 },
      { accountCode: "236805", debitCents: 0, creditCents: 2_100 },
    ];
    const docs = aggregateDocumentTaxes({ sales, purchases });
    const book = buildTaxAccountReport(lines, accounts);
    const cross = buildTaxCross(docs, book);
    expect(cross).toEqual([
      { key: "iva", referenceCents: 140_000, bookCents: 140_000, differenceCents: 0 },
      { key: "consumo", referenceCents: 40_000, bookCents: 40_000, differenceCents: 0 },
      { key: "retefuente", referenceCents: 7_500, bookCents: 7_500, differenceCents: 0 },
      { key: "reteica", referenceCents: 2_100, bookCents: 2_100, differenceCents: 0 },
    ]);
  });

  it("la diferencia es libro − documental y sale con signo", () => {
    const lines: TaxLedgerLine[] = [
      { accountCode: "24080501", debitCents: 0, creditCents: 190_000 },
      { accountCode: "24081001", debitCents: 50_000, creditCents: 0 },
      // Pago de la declaración anterior dentro del período: el libro baja.
      { accountCode: "24080501", debitCents: 30_000, creditCents: 0 },
      // Comprobante manual de reteIVA que los documentos no conocen.
      { accountCode: "236705", debitCents: 0, creditCents: 4_000 },
    ];
    const docs = aggregateDocumentTaxes({ sales, purchases });
    const book = buildTaxAccountReport(lines, [
      ...accounts,
      { code: "236705", name: "ReteIVA por pagar", type: "pasivo" },
    ]);
    const cross = buildTaxCross(docs, book);
    expect(cross.find((r) => r.key === "iva")).toEqual({
      key: "iva",
      referenceCents: 140_000,
      bookCents: 110_000,
      differenceCents: -30_000,
    });
    expect(cross.find((r) => r.key === "reteiva")).toEqual({
      key: "reteiva",
      referenceCents: 0,
      bookCents: 4_000,
      differenceCents: 4_000,
    });
    // INC sin asiento: documental 40.000 vs libro 0.
    expect(cross.find((r) => r.key === "consumo")).toEqual({
      key: "consumo",
      referenceCents: 40_000,
      bookCents: 0,
      differenceCents: -40_000,
    });
  });

  it("omite las familias sin cifra en ninguno de los dos lados", () => {
    const docs = aggregateDocumentTaxes({ sales: [], purchases: [] });
    const book = buildTaxAccountReport([], accounts);
    expect(buildTaxCross(docs, book)).toEqual([]);
  });
});

describe("cruce con líneas libres e IVA de compras no descontable", () => {
  // Factura con INC 8 % embebido (carta) + alquiler IVA 19 % y meseros INC
  // 8 % ENCIMA; compra de un comercio con IVA NO descontable (todo el IVA
  // es costo: inventario o gasto). Es lo que asienta el motor después del
  // arreglo: el IVA/INC encima al generado, nada al descontable.
  const freeSale: SaleTaxInput = {
    invoiceId: "i9",
    document: "FESM9",
    dateIso: "2026-08-10T15:00:00.000Z",
    taxKind: "inc",
    taxPct: 8,
    baseCents: 2_777_778,
    taxCents: 222_222,
    freeLineSlices: [
      { kind: "iva", pct: 19, baseCents: 10_000_000, taxCents: 1_900_000 },
      { kind: "inc", pct: 8, baseCents: 2_500_000, taxCents: 200_000 },
    ],
    customer: null,
  };
  const nonDeductible: PurchaseTaxInput = {
    ...purchases[0]!,
    retefuenteCents: 0,
    reteIcaCents: 0,
    lines: [
      // Inventariable: todo su IVA es mayor valor del inventario.
      { netCents: 100_000, taxPct: 19, nonDeductibleTaxCents: 19_000 },
      // No inventariable: congelado al recibir, va al gasto.
      { netCents: 50_000, taxPct: 19, nonDeductibleTaxCents: 9_500 },
    ],
  };

  it("documentos: el impuesto encima va a su propio kind:tarifa y el IVA de compras queda sin descontable", () => {
    const docs = aggregateDocumentTaxes({ sales: [freeSale], purchases: [nonDeductible] });
    expect(docs.sales.map((b) => [b.key, b.baseCents, b.taxCents])).toEqual([
      ["iva:19", 10_000_000, 1_900_000],
      ["inc:8", 5_277_778, 422_222],
    ]);
    expect(docs.totals).toMatchObject({
      incGeneradoCents: 422_222,
      ivaGeneradoCents: 1_900_000,
      ivaComprasCents: 28_500,
      ivaNoDescontableCents: 28_500,
      ivaDescontableCents: 0,
    });
  });

  it("libro del motor vs documentos: diferencia 0", () => {
    const lines: TaxLedgerLine[] = [
      // «Ventas del día»: INC embebido + INC encima; IVA 19 % encima.
      { accountCode: "241205", debitCents: 0, creditCents: 422_222 },
      { accountCode: "24080501", debitCents: 0, creditCents: 1_900_000 },
      // «Compras del día» de un comercio no descontable: nada a 2408.
    ];
    const docs = aggregateDocumentTaxes({ sales: [freeSale], purchases: [nonDeductible] });
    const cross = buildTaxCross(docs, buildTaxAccountReport(lines, accounts));
    expect(cross).toEqual([
      { key: "iva", referenceCents: 1_900_000, bookCents: 1_900_000, differenceCents: 0 },
      { key: "consumo", referenceCents: 422_222, bookCents: 422_222, differenceCents: 0 },
    ]);
  });
});
