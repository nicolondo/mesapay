// «Impuestos del período» desplegado: los GASTOS son el origen «gastos».
// Sus hechos suman lo mismo que el documental (`aggregateDocumentTaxes`),
// cuadran contra lo que asienta el motor (fuente `expense`, por fecha
// contable) y pasan por las revisiones antes de declarar.
import { describe, expect, it } from "vitest";
import { runTaxChecks, type CheckKey, type ChecksInput, type RetentionConceptFull } from "./taxesChecks";
import { aggregateDocumentTaxes, type ExpenseTaxInput } from "./taxesDocuments";
import { buildTaxDrill, expenseFacts, ledgerFacts, selectAux, type DocFact } from "./taxesDrill";
import { reconcileTaxes, type Reconciliation } from "./taxesReconcile";
import type { RetentionLedgerLine } from "./taxesDetail";
import type { TaxAccount } from "./taxesModel";
import { docHref } from "./auxRows";

const UVT = 5_237_400;

const expense = (id: string, over: Partial<ExpenseTaxInput> = {}): ExpenseTaxInput => ({
  expenseId: id,
  document: `FE-${id}`,
  dateIso: "2026-10-15T17:00:00.000Z",
  category: "Mantenimiento",
  documentType: "e_invoice",
  supplierName: "Refrigeración Andina",
  supplierTaxId: "901944469-1",
  baseCents: 100_000_000,
  ivaPct: 19,
  ivaCents: 19_000_000,
  nonDeductibleIvaCents: 0,
  incCents: 0,
  retefuenteCents: 4_000_000,
  reteIvaCents: 0,
  reteIcaCents: 0,
  retentions: [{ kind: "retefuente", name: "Servicios (4%)", rateBps: 400, baseCents: 100_000_000, amountCents: 4_000_000 }],
  href: `/operator/contabilidad?tab=expenses&month=2026-10&expense=${id}`,
  ...over,
});

describe("expenseFacts", () => {
  it("IVA descontable resta; el no descontable aporta 0 y queda a la vista; INC es costo (0)", () => {
    const facts = expenseFacts([
      expense("a"),
      expense("b", { ivaCents: 19_000_000, nonDeductibleIvaCents: 19_000_000, retefuenteCents: 0, retentions: [], incCents: 8_000_000 }),
    ]);
    const by = (k: string) => facts.find((f) => f.key === k)!;
    expect(by("gastos:a:iva:19")).toMatchObject({ tax: "iva", origin: "gastos", docKind: "expense", rateKey: "19", taxCents: -19_000_000, grossTaxCents: 19_000_000, nonDeductibleCents: 0 });
    expect(by("gastos:b:iva:19")).toMatchObject({ taxCents: 0, grossTaxCents: 19_000_000, nonDeductibleCents: 19_000_000 });
    expect(by("gastos:b:inc")).toMatchObject({ tax: "inc", rateKey: "x", taxCents: 0, grossTaxCents: 8_000_000 });
    expect(by("gastos:a:retefuente:0")).toMatchObject({ tax: "retefuente", rateKey: "400", conceptName: "Servicios (4%)", taxCents: 4_000_000, baseCents: 100_000_000 });
  });

  it("IVA impreso sin tarifa → tarifa efectiva; retención sin líneas → la tarifa que calce", () => {
    const facts = expenseFacts(
      [expense("c", { ivaPct: 0, ivaCents: 5_000_000, retentions: [], retefuenteCents: 2_500_000 })],
      [{ kind: "retefuente", name: "Compras (2,5%)", rateBps: 250, active: true }],
    );
    expect(facts.find((f) => f.tax === "iva")).toMatchObject({ rateKey: "e500", pct: 5 });
    expect(facts.find((f) => f.tax === "retefuente")).toMatchObject({ rateKey: "250", conceptName: "Compras (2,5%)", taxCents: 2_500_000 });
  });

  it("el despliegue suma lo mismo que el documental (IVA descontable y retenciones de gastos)", () => {
    const expenses = [
      expense("a"),
      expense("b", { ivaPct: 5, ivaCents: 5_000_000, retefuenteCents: 0, retentions: [], reteIcaCents: 700_000 }),
      expense("d", { ivaCents: 19_000_000, nonDeductibleIvaCents: 19_000_000 }),
    ];
    const drill = buildTaxDrill({ docs: expenseFacts(expenses), ledger: [] });
    const docs = aggregateDocumentTaxes({ sales: [], purchases: [], expenses });
    const tax = (k: string) => drill.taxes.find((t) => t.key === k)!;
    expect(tax("iva").docCents).toBe(-docs.totals.ivaGastosDescontableCents);
    expect(tax("retefuente").docCents).toBe(docs.totals.retefuenteCents);
    expect(tax("reteica").docCents).toBe(docs.totals.reteIcaCents);
    // Nivel 2 «Gastos · IVA 19 %» → nivel 3 sus dos gastos.
    const sel = selectAux({ docs: expenseFacts(expenses), ledger: [] }, "iva-gastos-19");
    expect(sel?.kind).toBe("docs");
    expect(sel && sel.kind === "docs" ? sel.rows.map((r) => r.docId) : []).toEqual(["a", "d"]);
  });

  it("el auxiliar enlaza al gasto abierto en su mes", () => {
    expect(docHref("expense", "g 1", "2026-10-15T17:00:00.000Z")).toBe(
      "/operator/contabilidad?tab=expenses&month=2026-10&expense=g%201",
    );
    expect(docHref("expense", "g1")).toBe("/operator/contabilidad?tab=expenses&expense=g1");
  });
});

describe("reconciliación con el asiento «Gastos» del motor", () => {
  const accounts: TaxAccount[] = [
    { code: "24081001", name: "IVA descontable 19%", type: "pasivo" },
    { code: "236505", name: "Retefuente", type: "pasivo" },
  ];
  const line = (id: string, code: string, debit: number, credit: number): RetentionLedgerLine => ({
    id,
    entryId: "e-gastos",
    accountCode: code,
    debitCents: debit,
    creditCents: credit,
    dateIso: "2026-10-15T05:00:00.000Z",
    voucherNumber: null,
    source: "expense",
    status: "posted",
  });
  const period = { desde: "2026-10-01", hasta: "2026-10-31" };
  const recon = (docs: DocFact[], ledger: RetentionLedgerLine[]): Reconciliation =>
    reconcileTaxes({
      period,
      cutoffHour: 5,
      docs,
      windowSaleFacts: [],
      windowPurchaseFacts: [],
      orders: [],
      ledger: ledgerFacts(ledger, accounts),
      entries: ledger.length ? [{ id: "e-gastos", source: "expense", day: "2026-10-15", voucher: null }] : [],
    });

  it("con el asiento del día, el gasto cuadra (sin diferencias)", () => {
    const r = recon(expenseFacts([expense("a")]), [line("l1", "24081001", 19_000_000, 0), line("l2", "236505", 0, 4_000_000)]);
    expect(r.rows.desactualizado).toEqual([]);
    expect(r.rows.sinAsiento).toEqual([]);
    expect(r.byTax.find((t) => t.tax === "iva")!.diffCents).toBe(0);
  });

  it("sin asiento (asientos sin generar), el gasto sale como «sin asiento»", () => {
    const r = recon(expenseFacts([expense("a")]), []);
    expect(r.rows.sinAsiento.map((f) => [f.origin, f.tax, f.docId])).toEqual(
      expect.arrayContaining([
        ["gastos", "iva", "a"],
        ["gastos", "retefuente", "a"],
      ]),
    );
  });
});

describe("revisiones con gastos", () => {
  const EMPTY: Reconciliation = {
    byTax: [],
    rows: { sinFactura: [], corte: [], cuentaAnulada: [], sinAsiento: [], desactualizado: [], sinDocumento: [] },
  };
  const concept = (over: Partial<RetentionConceptFull>): RetentionConceptFull => ({
    kind: "retefuente",
    name: "Servicios (4%)",
    rateBps: 400,
    base: "subtotal",
    thresholdUvt: 4,
    active: true,
    ...over,
  });
  const input = (expenses: ExpenseTaxInput[], over: Partial<ChecksInput> = {}): ChecksInput => ({
    recon: EMPTY,
    sales: [],
    purchases: [],
    expenses,
    docs: expenseFacts(expenses),
    currentTax: { kind: "iva", pct: 19 },
    purchaseIvaDeductible: true,
    concepts: [],
    uvtCents: UVT,
    cutoffHour: 5,
    entries: [],
    dianInvoices: new Map(),
    dianCreditNotes: [],
    freeLineTaxByInvoice: new Map(),
    ...over,
  });
  const get = (i: ChecksInput, k: CheckKey) => runTaxChecks(i).find((c) => c.key === k)!;

  it("retención omitida: un concepto activo aplica y el gasto no la practicó (una retefuente, la de su categoría)", () => {
    const concepts = [concept({}), concept({ name: "Arrendamientos (3,5%)", rateBps: 350, thresholdUvt: 27 })];
    // Arriendo de $2.000.000 (≥ 27 UVT): se esperaba la de arrendamientos.
    const big = input([expense("a", { baseCents: 200_000_000, retefuenteCents: 0, retentions: [], category: "Arriendo local" })], { concepts });
    const c = get(big, "retencionOmitida");
    expect(c.count).toBe(1);
    expect(c.rows[0]).toMatchObject({ docKind: "expense", docId: "a", conceptName: "Arrendamientos (3,5%)", amountCents: 7_000_000 });
    // Arriendo de $1.000.000 (< 27 UVT): no aplica; no se le exige la de servicios.
    const small = input([expense("b", { retefuenteCents: 0, retentions: [], category: "Arriendo local" })], { concepts });
    expect(get(small, "retencionOmitida").count).toBe(0);
  });

  it("retención bajo el umbral: el gasto retuvo sin alcanzar la base mínima", () => {
    const small = expense("s", { baseCents: 1_000_000, ivaCents: 190_000, retefuenteCents: 40_000, retentions: [] });
    const c = get(input([small], { concepts: [concept({})] }), "retencionBajoUmbral");
    expect(c.count).toBe(1);
    expect(c.rows[0]).toMatchObject({ docKind: "expense", amountCents: 40_000 });
  });

  it("IVA descontable sin poder descontar y proveedor sin NIT también miran los gastos", () => {
    const iva = get(input([expense("a")], { purchaseIvaDeductible: false }), "ivaNoDescontable");
    expect(iva.rows).toEqual([expect.objectContaining({ docKind: "expense", docId: "a", amountCents: 19_000_000 })]);
    const nit = get(input([expense("a", { supplierTaxId: null })]), "terceroSinNit");
    expect(nit.rows).toEqual([expect.objectContaining({ key: "gastos:a", flags: ["noNit"] })]);
  });
});
