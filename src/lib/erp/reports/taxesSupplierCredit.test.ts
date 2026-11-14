import { describe, expect, it } from "vitest";
import { aggregateDocumentTaxes, type PurchaseTaxInput, type SupplierCreditNoteTaxInput } from "./taxesDocuments";

const purchase: PurchaseTaxInput = {
  purchaseId: "p1",
  document: "FE-1",
  dateIso: "2026-11-02T12:00:00Z",
  supplierName: "Proveedor",
  supplierTaxId: null,
  lines: [{ netCents: 1_000_000, taxPct: 19, taxCents: 190_000, nonDeductibleTaxCents: 0 }],
  incCents: 0,
  retefuenteCents: 0,
  reteIvaCents: 0,
  reteIcaCents: 0,
};
const note = (over: Partial<SupplierCreditNoteTaxInput> = {}): SupplierCreditNoteTaxInput => ({
  creditNoteId: "n1",
  document: "NC-1",
  dateIso: "2026-11-10T17:00:00Z",
  supplierName: "Proveedor",
  supplierTaxId: null,
  sign: -1,
  ivaPct: 19,
  baseCents: 100_000,
  ivaCents: 19_000,
  nonDeductibleIvaCents: 0,
  incCents: 0,
  ...over,
});

describe("impuestos del período: notas crédito de proveedores", () => {
  it("el IVA de la nota resta del IVA descontable de compras de su tarifa", () => {
    const d = aggregateDocumentTaxes({ sales: [], purchases: [purchase], supplierCreditNotes: [note()] });
    const b = d.purchases.find((x) => x.key === "iva:19")!;
    expect(b.taxCents).toBe(171_000);
    expect(b.creditNoteTaxCents).toBe(19_000);
    expect(d.totals.ivaComprasCents).toBe(171_000);
    expect(d.totals.ivaDescontableCents).toBe(171_000);
    expect(d.totals.supplierCreditNoteIvaCents).toBe(19_000);
  });

  it("IVA no descontable: baja el IVA de compras y su parte no descontable (el descontable no cambia)", () => {
    const nd: PurchaseTaxInput = { ...purchase, lines: [{ ...purchase.lines[0]!, nonDeductibleTaxCents: 190_000 }] };
    const d = aggregateDocumentTaxes({ sales: [], purchases: [nd], supplierCreditNotes: [note({ nonDeductibleIvaCents: 19_000 })] });
    expect(d.totals.ivaComprasCents).toBe(171_000);
    expect(d.totals.ivaNoDescontableCents).toBe(171_000);
    expect(d.totals.ivaDescontableCents).toBe(0);
  });

  it("su anulación en el período lo devuelve", () => {
    const d = aggregateDocumentTaxes({
      sales: [],
      purchases: [purchase],
      supplierCreditNotes: [note(), note({ sign: 1 })],
    });
    expect(d.totals.ivaComprasCents).toBe(190_000);
  });

  it("sin notas, nada cambia", () => {
    const d = aggregateDocumentTaxes({ sales: [], purchases: [purchase] });
    expect(d.totals.ivaComprasCents).toBe(190_000);
  });
});
