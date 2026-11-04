import { describe, expect, it } from "vitest";
import type { RetentionLedgerLine } from "./taxesDetail";
import {
  aggregateDocumentTaxes,
  type CreditNoteTaxInput,
  type PurchaseTaxInput,
  type SaleTaxInput,
} from "./taxesDocuments";
import {
  buildTaxDrill,
  creditNoteFacts,
  DRILL_TAXES,
  ledgerFacts,
  paginate,
  purchaseFacts,
  refundFacts,
  retentionRate,
  salesFacts,
  selectAux,
  sumSelection,
  TAX_FAMILY,
  type DrillFacts,
} from "./taxesDrill";
import { buildTaxAccountReport, familySubtotal, type TaxAccount } from "./taxesModel";
import { saleTaxOfSnapshot } from "./saleTaxSnapshot";
import { tileValue } from "./taxesTrend";

const sale = (id: string, kind: SaleTaxInput["taxKind"], pct: number, base: number, tax: number, day = "2026-10-05"): SaleTaxInput => ({
  invoiceId: id,
  document: `FE${id}`,
  dateIso: `${day}T20:00:00.000Z`,
  taxKind: kind,
  taxPct: pct,
  baseCents: base,
  taxCents: tax,
  customer: id === "3" ? { name: "ACME S.A.S.", docType: "NIT", docNumber: "900123456" } : null,
});

const SALES: SaleTaxInput[] = [
  sale("1", "inc", 8, 100_000, 8_000),
  sale("2", "inc", 8, 250_000, 20_000, "2026-10-09"),
  sale("3", "iva", 19, 100_000, 19_000),
  sale("4", "iva", 0, 50_000, 0),
  sale("5", "none", 0, 70_000, 0),
];

const NOTES: CreditNoteTaxInput[] = [
  {
    creditNoteId: "n1",
    document: "NC1",
    reference: "FE2",
    dateIso: "2026-10-12T12:00:00.000Z",
    customer: null,
    slices: [
      { kind: "inc", pct: 8, baseCents: 50_000, taxCents: 4_000 },
      { kind: "none", pct: 0, baseCents: 1_000, taxCents: 0 },
    ],
  },
];

const PURCHASES: PurchaseTaxInput[] = [
  {
    purchaseId: "p1",
    document: "FV-77",
    dateIso: "2026-10-03T15:00:00.000Z",
    supplierName: "Carnes La Pradera",
    supplierTaxId: "900111222-3",
    lines: [
      { netCents: 1_000_000, taxPct: 19, taxCents: null, nonDeductibleTaxCents: 0 },
      { netCents: 200_000, taxPct: 19, taxCents: null, nonDeductibleTaxCents: 38_000 },
      { netCents: 300_000, taxPct: 5, taxCents: null, nonDeductibleTaxCents: 0 },
      { netCents: 100_000, taxPct: 0, taxCents: null, nonDeductibleTaxCents: 0 },
    ],
    incCents: 0,
    retefuenteCents: 40_000, // 2,5 % de 1.600.000
    reteIvaCents: 0,
    reteIcaCents: 1_234, // no calza con ningún concepto
  },
  {
    purchaseId: "p2",
    document: "OC-0002",
    dateIso: "2026-10-20T15:00:00.000Z",
    supplierName: "Fruver",
    supplierTaxId: null,
    lines: [{ netCents: 500_000, taxPct: 0, taxCents: null, nonDeductibleTaxCents: 0 }],
    incCents: 0,
    retefuenteCents: 20_000, // 4 % de 500.000 (servicios)
    reteIvaCents: 0,
    reteIcaCents: 0,
  },
];

const CONCEPTS = [
  { kind: "retefuente", name: "Compras (2,5%)", rateBps: 250, active: true },
  { kind: "retefuente", name: "Servicios (4%)", rateBps: 400, active: false },
  { kind: "retefuente", name: "Otro 2,5 % inactivo", rateBps: 250, active: false },
];

const ACCOUNTS: TaxAccount[] = [
  { code: "241205", name: "Impuesto al consumo", type: "pasivo" },
  { code: "24080501", name: "IVA generado 19%", type: "pasivo" },
  { code: "24081001", name: "IVA descontable", type: "pasivo" },
  { code: "236505", name: "Retención en la fuente", type: "pasivo" },
  { code: "236805", name: "ReteICA", type: "pasivo" },
  { code: "135515", name: "Retefuente a favor", type: "activo" },
];

const line = (
  id: string,
  code: string,
  debit: number,
  credit: number,
  source = "sale",
  day = "2026-10-05",
): RetentionLedgerLine => ({
  id,
  entryId: `e-${source}-${day}`,
  accountCode: code,
  debitCents: debit,
  creditCents: credit,
  dateIso: `${day}T05:00:00.000Z`,
  voucherNumber: null,
  source,
  status: "posted",
});

const LINES: RetentionLedgerLine[] = [
  line("l1", "241205", 0, 8_000),
  line("l2", "241205", 0, 20_000, "sale", "2026-10-09"),
  line("l3", "24080501", 0, 19_000),
  line("l4", "241205", 4_000, 0, "credit_note", "2026-10-12"),
  line("l5", "24081001", 205_000, 0, "purchase", "2026-10-03"),
  line("l6", "236505", 0, 40_000, "purchase", "2026-10-03"),
  line("l7", "236505", 0, 20_000, "purchase", "2026-10-20"),
  line("l8", "236805", 0, 1_234, "purchase", "2026-10-03"),
  line("l9", "241205", 0, 500, "manual", "2026-10-31"),
  line("l10", "135515", 7_000, 0, "manual", "2026-10-31"),
  line("l11", "241205", 100, 100, "manual", "2026-10-31"), // neto 0: no aporta
];

function facts(refundsCents = 10_800): DrillFacts {
  return {
    docs: [
      ...salesFacts(SALES),
      ...creditNoteFacts(NOTES),
      ...refundFacts(refundsCents, SALES, { kind: "inc", pct: 8 }, "2026-10-31T12:00:00.000Z"),
      ...purchaseFacts(PURCHASES, CONCEPTS),
    ],
    ledger: ledgerFacts(LINES, ACCOUNTS),
  };
}

describe("buildTaxDrill — nivel 1 contra los agregadores de siempre", () => {
  it("cada impuesto documental es la tesela de `aggregateDocumentTaxes`", () => {
    const agg = aggregateDocumentTaxes({
      sales: SALES,
      purchases: PURCHASES,
      creditNotes: NOTES,
      refundsCents: 10_800,
      currentTax: { kind: "inc", pct: 8 },
    });
    const drill = buildTaxDrill(facts());
    for (const t of drill.taxes) expect(t.docCents, t.key).toBe(tileValue(agg.totals, t.key));
    // A mano: INC = 8.000 + 20.000 − 4.000 − 800 (devolución 10.800 al 8 %).
    expect(drill.taxes.find((t) => t.key === "inc")!.docCents).toBe(23_200);
    // IVA = 19.000 − (190.000 + 38.000 − 38.000 + 15.000) descontable.
    expect(drill.taxes.find((t) => t.key === "iva")!.docCents).toBe(19_000 - 205_000);
  });

  it("cada impuesto del libro es el subtotal de su familia en `buildTaxAccountReport`", () => {
    const book = buildTaxAccountReport(LINES, ACCOUNTS);
    const drill = buildTaxDrill(facts());
    for (const t of drill.taxes) expect(t.bookCents, t.key).toBe(familySubtotal(book, TAX_FAMILY[t.key]));
    expect(drill.others.valueCents).toBe(familySubtotal(book, "retefuente-favor"));
    expect(drill.others.nodes.map((n) => n.id)).toEqual(["otros-retefuente-favor"]);
  });

  it("estado: cuadra, diferencia o sin movimiento", () => {
    const drill = buildTaxDrill(facts());
    const by = Object.fromEntries(drill.taxes.map((t) => [t.key, t]));
    expect(by.retefuente!.status).toBe("ok");
    expect(by.reteica!.status).toBe("ok");
    expect(by.inc!.status).toBe("diff");
    expect(by.inc!.diffCents).toBe(8_000 + 20_000 - 4_000 + 500 - 23_200);
    expect(by.reteiva!.status).toBe("empty");
  });
});

describe("niveles 2 y 3 concilian con su padre al centavo", () => {
  it("Σ nivel 2 = nivel 1 y Σ auxiliares = renglón del nivel 2", () => {
    const f = facts();
    const drill = buildTaxDrill(f);
    for (const t of drill.taxes) {
      expect(t.docNodes.reduce((s, n) => s + n.taxCents, 0)).toBe(t.docCents);
      expect(t.bookNodes.reduce((s, n) => s + n.valueCents, 0)).toBe(t.bookCents);
      for (const n of t.docNodes) {
        const sel = selectAux(f, n.id)!;
        expect(sel.kind).toBe("docs");
        const sum = sumSelection(sel);
        expect(sum.valueCents, n.id).toBe(n.taxCents);
        expect(sum.baseCents, n.id).toBe(n.baseCents);
        expect(sum.count).toBe(n.count);
      }
      for (const n of t.bookNodes) {
        const sel = selectAux(f, n.id)!;
        expect(sel.kind).toBe("ledger");
        expect(sumSelection(sel).valueCents, n.id).toBe(n.valueCents);
      }
    }
    for (const n of drill.others.nodes) expect(sumSelection(selectAux(f, n.id)!).valueCents).toBe(n.valueCents);
  });

  it("los renglones van por origen y tarifa, con ids estables para la URL", () => {
    const drill = buildTaxDrill(facts());
    const inc = drill.taxes.find((t) => t.key === "inc")!;
    expect(inc.docNodes.map((n) => n.id)).toEqual(["inc-ventas-8", "inc-notas-8", "inc-devoluciones-8"]);
    expect(inc.bookNodes.map((n) => [n.id, n.count])).toEqual([
      ["inc-libro-sale", 2],
      ["inc-libro-credit_note", 1],
      ["inc-libro-manual", 1],
    ]);
    const iva = drill.taxes.find((t) => t.key === "iva")!;
    expect(iva.docNodes.map((n) => n.id)).toEqual(["iva-ventas-19", "iva-ventas-0", "iva-compras-19", "iva-compras-5"]);
  });

  it("IVA de compras: el aporte es el DESCONTABLE y conserva registrado y no descontable", () => {
    const f = purchaseFacts(PURCHASES, CONCEPTS).find((x) => x.key === "compras:p1:iva:19")!;
    expect(f.baseCents).toBe(1_200_000);
    expect(f.grossTaxCents).toBe(228_000);
    expect(f.nonDeductibleCents).toBe(38_000);
    expect(f.taxCents).toBe(-190_000);
  });

  it("una venta en «none» o vacía no aporta; una al 0 % sí (base)", () => {
    const f = salesFacts(SALES);
    expect(f.map((x) => x.key)).toEqual(["inv:1", "inv:2", "inv:3", "inv:4"]);
    expect(salesFacts([sale("9", "inc", 8, 0, 0)])).toEqual([]);
  });

  it("selectAux: id desconocido o renglón sin filas → null", () => {
    const f = facts();
    expect(selectAux(f, "inc-ventas-19")).toBeNull();
    expect(selectAux(f, "nada")).toBeNull();
    expect(selectAux(f, "reteiva-libro-sale")).toEqual({ kind: "ledger", rows: [] });
  });

  it("auxiliares en orden de fecha", () => {
    const sel = selectAux(facts(), "inc-ventas-8")!;
    expect(sel.rows.map((r) => r.key)).toEqual(["inv:1", "inv:2"]);
  });
});

describe("retentionRate", () => {
  it("empareja el concepto que reproduce el valor exacto, el activo primero", () => {
    expect(retentionRate("retefuente", 1_600_000, 40_000, CONCEPTS)).toEqual({
      rateKey: "250",
      pct: 2.5,
      conceptName: "Compras (2,5%)",
    });
    expect(retentionRate("retefuente", 500_000, 20_000, CONCEPTS).conceptName).toBe("Servicios (4%)");
  });
  it("sin concepto: tarifa efectiva; sin base: «x»", () => {
    expect(retentionRate("reteica", 1_600_000, 1_234, CONCEPTS)).toEqual({ rateKey: "e8", pct: 0.08, conceptName: null });
    expect(retentionRate("retefuente", 0, 500, CONCEPTS)).toEqual({ rateKey: "x", pct: null, conceptName: null });
  });
});

describe("ledgerFacts", () => {
  it("clasifica por familia, con signo de naturaleza y sin líneas en cero", () => {
    const l = ledgerFacts(LINES, ACCOUNTS);
    expect(l.find((x) => x.key === "l5")).toMatchObject({ tax: "iva", valueCents: -205_000, source: "purchase" });
    expect(l.find((x) => x.key === "l10")).toMatchObject({ tax: null, family: "retefuente-favor", valueCents: 7_000 });
    expect(l.find((x) => x.key === "l11")).toBeUndefined();
  });
  it("un concepto de retención manda sobre el prefijo", () => {
    const l = ledgerFacts([line("x", "289595", 0, 900, "purchase")], [], new Map([["289595", "reteica"]]));
    expect(l[0]).toMatchObject({ tax: "reteica", valueCents: 900 });
  });
});

describe("paginate", () => {
  it("corta páginas y acota la página pedida", () => {
    const rows = Array.from({ length: 7 }, (_, i) => i);
    expect(paginate(rows, 2, 3)).toEqual({ rows: [3, 4, 5], page: 2, pages: 3 });
    expect(paginate(rows, 9, 3)).toEqual({ rows: [6], page: 3, pages: 3 });
    expect(paginate([], 1, 3)).toEqual({ rows: [], page: 1, pages: 1 });
  });
});

describe("saleTaxOfSnapshot", () => {
  const base = { subtotalCents: 108_000 } as const;
  it("tarifa congelada e impuesto embebido", () => {
    expect(
      saleTaxOfSnapshot({ ...base, salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 8_000, embeddedBaseCents: 100_000 }),
    ).toEqual({ kind: "inc", pct: 8, taxCents: 8_000, baseCents: 100_000 });
  });
  it("snapshot viejo sin tarifa → none; sin base congelada → subtotal − impuesto", () => {
    expect(saleTaxOfSnapshot({ ...base })).toEqual({ kind: "none", pct: 0, taxCents: 0, baseCents: 108_000 });
    expect(saleTaxOfSnapshot({ ...base, salesTaxKind: "iva", salesTaxPct: 19, embeddedTaxCents: 17_244 })).toEqual({
      kind: "iva",
      pct: 19,
      taxCents: 17_244,
      baseCents: 90_756,
    });
  });
  it("todos los impuestos del resumen existen en el árbol", () => {
    expect(buildTaxDrill({ docs: [], ledger: [] }).taxes.map((t) => t.key)).toEqual([...DRILL_TAXES]);
  });
});
