import { describe, expect, it } from "vitest";
import {
  buildTaxesDetail,
  purchaseDetailRows,
  retentionConceptLabel,
  retentionDetailRows,
  salesDetailRows,
  taxesDetailCsvRows,
  type RetentionLedgerLine,
} from "./taxesDetail";
import type { PurchaseTaxInput, SaleTaxInput } from "./taxesDocuments";
import type { TaxAccount } from "./taxesModel";

const sales: SaleTaxInput[] = [
  {
    invoiceId: "i2",
    document: "FESM2",
    dateIso: "2026-08-12T20:00:00.000Z",
    taxKind: "iva",
    taxPct: 19,
    baseCents: 200_000,
    taxCents: 38_000,
    customer: { name: "ACME S.A.S.", docType: "NIT", docNumber: "900123456" },
  },
  {
    invoiceId: "i1",
    document: "FESM1",
    dateIso: "2026-08-10T15:00:00.000Z",
    taxKind: "inc",
    taxPct: 8,
    baseCents: 100_000,
    taxCents: 8_000,
    customer: null,
  },
  {
    invoiceId: "i3",
    document: "FESM3",
    dateIso: "2026-08-13T15:00:00.000Z",
    taxKind: "none",
    taxPct: 0,
    baseCents: 50_000,
    taxCents: 0,
    customer: null,
  },
];

const purchases: PurchaseTaxInput[] = [
  {
    purchaseId: "p1",
    document: "F-77",
    dateIso: "2026-08-12T00:00:00.000Z",
    supplierName: "Distribuidora",
    supplierTaxId: "800111222",
    lines: [
      { netCents: 100_000, taxPct: 19, nonDeductibleTaxCents: 0 },
      { netCents: 20_000, taxPct: 19, nonDeductibleTaxCents: 0 }, // misma tarifa: se agrupa
      { netCents: 50_000, taxPct: 5, nonDeductibleTaxCents: 0 },
      { netCents: 10_000, taxPct: 0, nonDeductibleTaxCents: 0 }, // sin IVA: no sale
    ],
    incCents: 0,
    retefuenteCents: 0,
    reteIvaCents: 0,
    reteIcaCents: 0,
  },
];

const accounts: TaxAccount[] = [
  { code: "236505", name: "Retención en la fuente por pagar", type: "pasivo" },
  { code: "236705", name: "ReteIVA por pagar", type: "pasivo" },
  { code: "135515", name: "Retención en la fuente", type: "activo" },
  { code: "24080501", name: "IVA generado 19%", type: "pasivo" },
];

const ledger = (
  id: string,
  accountCode: string,
  debitCents: number,
  creditCents: number,
  extra: Partial<RetentionLedgerLine> = {},
): RetentionLedgerLine => ({
  id,
  entryId: `e-${id}`,
  accountCode,
  debitCents,
  creditCents,
  dateIso: "2026-08-31T23:59:59.999Z",
  voucherNumber: 123,
  source: "purchase",
  status: "posted",
  ...extra,
});

describe("filas de ventas", () => {
  it("una fila por factura con impuesto, ordenadas por fecha; nominativa vs consumidor final", () => {
    const rows = salesDetailRows(sales);
    expect(rows.map((r) => r.document)).toEqual(["FESM1", "FESM2"]);
    expect(rows[0]).toMatchObject({ nit: null, party: null, kind: "inc", pct: 8, baseCents: 100_000, valorCents: 8_000 });
    expect(rows[1]).toMatchObject({ nit: "900123456", party: "ACME S.A.S.", kind: "iva", pct: 19, valorCents: 38_000 });
  });
});

describe("filas de compras", () => {
  it("una fila por documento y tarifa (las líneas de la misma tarifa se suman)", () => {
    const rows = purchaseDetailRows(purchases);
    expect(rows.map((r) => [r.document, r.pct, r.baseCents, r.valorCents])).toEqual([
      ["F-77", 19, 120_000, 22_800],
      ["F-77", 5, 50_000, 2_500],
    ]);
    expect(rows[0]).toMatchObject({ nit: "800111222", party: "Distribuidora", kind: "iva" });
  });
});

describe("retenciones desde el libro", () => {
  it("pasivo → practicada (C − D); activo → a favor (D − C); el IVA no entra", () => {
    const { practicadas, aFavor } = retentionDetailRows(
      [
        ledger("l1", "236505", 0, 7_500),
        ledger("l2", "135515", 3_000, 0, { source: "manual", voucherNumber: null, thirdPartyName: "Cliente S.A.", thirdPartyTaxId: "890000000" }),
        ledger("l3", "24080501", 0, 190_000),
        // Reversa de una retención: sale negativa en practicadas.
        ledger("l4", "236505", 7_500, 0, { source: "manual", status: "posted" }),
        // Neto cero: no sale.
        ledger("l5", "236705", 100, 100),
      ],
      accounts,
      { conceptsByCode: new Map([["236505", { kind: "retefuente", name: "Compras (2,5%)" }]]) },
    );
    expect(practicadas.map((r) => [r.accountCode, r.valorCents])).toEqual([
      ["236505", 7_500],
      ["236505", -7_500],
    ]);
    expect(practicadas[0]).toMatchObject({
      voucher: "#000123",
      source: "purchase",
      conceptName: "Compras (2,5%)",
      family: "retefuente",
      voided: false,
    });
    expect(retentionConceptLabel(practicadas[0]!)).toBe("Compras (2,5%) (236505)");
    expect(aFavor).toEqual([
      expect.objectContaining({
        accountCode: "135515",
        valorCents: 3_000,
        voucher: null,
        nit: "890000000",
        party: "Cliente S.A.",
        conceptName: null,
        family: "retefuente-favor",
      }),
    ]);
    expect(retentionConceptLabel(aFavor[0]!)).toBe("Retención en la fuente (135515)");
  });

  it("un asiento anulado por reversa sigue sumando y queda marcado", () => {
    const { practicadas } = retentionDetailRows(
      [ledger("l1", "236505", 0, 7_500, { status: "annulled" })],
      accounts,
    );
    expect(practicadas[0]).toMatchObject({ valorCents: 7_500, voided: true });
  });
});

describe("reporte completo y CSV", () => {
  const detail = buildTaxesDetail({
    sales,
    purchases,
    ledgerLines: [ledger("l1", "236505", 0, 7_500), ledger("l2", "135515", 3_000, 0)],
    accounts,
    conceptsByCode: new Map([["236505", { kind: "retefuente", name: "Compras (2,5%)" }]]),
  });

  it("stats: IVA generado, INC generado, IVA descontable, retenciones practicadas y a favor", () => {
    expect(detail.stats).toEqual({
      ivaGeneradoCents: 38_000,
      incGeneradoCents: 8_000,
      ivaDescontableCents: 25_300,
      retencionesPracticadasCents: 7_500,
      retencionesAFavorCents: 3_000,
    });
  });

  it("CSV: Sección, Fecha, Documento, NIT, Tercero, Impuesto/Concepto, Tarifa, Base, Valor", () => {
    const rows = taxesDetailCsvRows(detail, {
      sections: { sales: "V", purchases: "C", practicadas: "RP", aFavor: "RF" },
      taxLabel: (k) => (k === "iva" ? "IVA" : "INC"),
      finalConsumer: "Consumidor final",
      unnumbered: "sin numerar",
      voided: "Anulado",
      sourceLabel: (s) => `[${s}]`,
    });
    expect(rows).toEqual([
      ["V", "2026-08-10", "FESM1", "", "Consumidor final", "INC", "8 %", 100_000, 8_000],
      ["V", "2026-08-12", "FESM2", "900123456", "ACME S.A.S.", "IVA", "19 %", 200_000, 38_000],
      ["C", "2026-08-12", "F-77", "800111222", "Distribuidora", "IVA", "19 %", 120_000, 22_800],
      ["C", "2026-08-12", "F-77", "800111222", "Distribuidora", "IVA", "5 %", 50_000, 2_500],
      ["RP", "2026-08-31", "#000123 · [purchase]", "", "", "Compras (2,5%) (236505)", "", null, 7_500],
      ["RF", "2026-08-31", "#000123 · [purchase]", "", "", "Retención en la fuente (135515)", "", null, 3_000],
    ]);
  });
});
