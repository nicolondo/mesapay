// Impuestos del período: los GASTOS son un origen aparte de las compras.
// Sus IVA/INC salen en su propia tabla; sólo el IVA descontable cruza
// contra el generado (como en su asiento); sus retenciones suman a las
// practicadas, que el libro también tiene.
import { describe, expect, it } from "vitest";
import { aggregateDocumentTaxes, documentFamilies, type ExpenseTaxInput, type SaleTaxInput } from "./taxesDocuments";
import { buildTaxCross } from "./taxesCross";
import { buildTaxAccountReport, type TaxAccount, type TaxLedgerLine } from "./taxesModel";
import { expenseDetailRows } from "./taxesDetail";
import { expenseHref } from "./taxesQueries";

const sales: SaleTaxInput[] = [
  {
    invoiceId: "i1",
    document: "FE1",
    dateIso: "2026-08-10T15:00:00.000Z",
    taxKind: "iva",
    taxPct: 19,
    baseCents: 1_000_000,
    taxCents: 190_000,
    customer: null,
  },
];

const expense = (over: Partial<ExpenseTaxInput> = {}): ExpenseTaxInput => ({
  expenseId: "e1",
  document: "FE-901",
  dateIso: "2026-08-15T17:00:00.000Z",
  category: "Mantenimiento",
  documentType: "e_invoice",
  supplierName: "Refrigeración Andina",
  supplierTaxId: "900123456-7",
  baseCents: 200_000,
  ivaPct: 19,
  ivaCents: 38_000,
  nonDeductibleIvaCents: 0,
  incCents: 0,
  retefuenteCents: 8_000,
  reteIvaCents: 5_700,
  reteIcaCents: 0,
  href: "/operator/contabilidad?tab=expenses&month=2026-08&expense=e1",
  ...over,
});

describe("origen «gastos» en Impuestos del período", () => {
  it("IVA por tarifa e INC en su propia tabla; las compras no cambian", () => {
    const docs = aggregateDocumentTaxes({
      sales,
      purchases: [],
      expenses: [
        expense(),
        expense({ expenseId: "e2", ivaPct: 0, ivaCents: 0, incCents: 16_000, baseCents: 200_000, retefuenteCents: 0, reteIvaCents: 0 }),
      ],
    });
    expect(docs.purchases).toEqual([]);
    expect(docs.expenses).toEqual([
      expect.objectContaining({ key: "iva:19", baseCents: 200_000, taxCents: 38_000 }),
      expect.objectContaining({ key: "inc:-", baseCents: 200_000, taxCents: 16_000 }),
    ]);
    expect(docs.totals).toMatchObject({
      ivaGastosCents: 38_000,
      ivaGastosDescontableCents: 38_000,
      incGastosCents: 16_000,
      retencionesGastosCents: 13_700,
      retefuenteCents: 8_000,
      reteIvaCents: 5_700,
      ivaComprasCents: 0,
      ivaDescontableCents: 0,
    });
    expect(docs.ivaDiferenciaDocumentalCents).toBe(190_000 - 38_000);
    expect(documentFamilies(docs)).toEqual(["iva", "inc"]);
  });

  it("el cruce resta sólo el IVA DESCONTABLE de los gastos y cuadra contra el libro del motor", () => {
    const docs = aggregateDocumentTaxes({
      sales,
      purchases: [],
      expenses: [expense(), expense({ expenseId: "e3", ivaCents: 19_000, nonDeductibleIvaCents: 19_000, retefuenteCents: 0, reteIvaCents: 0, baseCents: 100_000 })],
    });
    // Lo que asienta el motor: 24081001 sólo con el descontable (38.000).
    const lines: TaxLedgerLine[] = [
      { accountCode: "24080501", debitCents: 0, creditCents: 190_000 },
      { accountCode: "24081001", debitCents: 38_000, creditCents: 0 },
      { accountCode: "236505", debitCents: 0, creditCents: 8_000 },
      { accountCode: "236705", debitCents: 0, creditCents: 5_700 },
    ];
    const accounts: TaxAccount[] = [
      { code: "24080501", name: "IVA generado 19%", type: "pasivo" },
      { code: "24081001", name: "IVA descontable 19%", type: "pasivo" },
      { code: "236505", name: "Retefuente", type: "pasivo" },
      { code: "236705", name: "ReteIVA", type: "pasivo" },
    ];
    const cross = buildTaxCross(docs, buildTaxAccountReport(lines, accounts));
    expect(cross).toEqual([
      { key: "iva", referenceCents: 152_000, bookCents: 152_000, differenceCents: 0 },
      { key: "retefuente", referenceCents: 8_000, bookCents: 8_000, differenceCents: 0 },
      { key: "reteiva", referenceCents: 5_700, bookCents: 5_700, differenceCents: 0 },
    ]);
    expect(docs.totals.ivaGastosNoDescontableCents).toBe(19_000);
  });

  it("detalle: una fila por gasto e impuesto, con su enlace y la parte no descontable", () => {
    const rows = expenseDetailRows([
      expense({ ivaCents: 38_000, nonDeductibleIvaCents: 38_000, incCents: 4_000 }),
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ key: "exp:e1:iva", kind: "iva", pct: 19, valorCents: 38_000, nonDeductibleCents: 38_000, href: expect.stringContaining("expense=e1") }),
      expect.objectContaining({ key: "exp:e1:inc", kind: "inc", valorCents: 4_000 }),
    ]);
  });

  it("el enlace abre el gasto en su mes", () => {
    expect(expenseHref("e 1", new Date("2026-08-15T17:00:00Z"))).toBe(
      "/operator/contabilidad?tab=expenses&month=2026-08&expense=e%201",
    );
  });

  it("sin gastos, el reporte es el de siempre", () => {
    const docs = aggregateDocumentTaxes({ sales, purchases: [] });
    expect(docs.expenses).toEqual([]);
    expect(docs.totals).toMatchObject({ ivaGastosCents: 0, retencionesGastosCents: 0 });
  });
});
