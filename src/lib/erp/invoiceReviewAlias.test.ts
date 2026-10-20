import { describe, expect, it } from "vitest";
import { applyInvoiceSupplierMatch, chooseInvoiceIngredient, resetInvoiceSupplier } from "./invoiceReviewAlias";
import { reviewLineAmounts, reviewLineQtyBase, type InvoiceReviewLine } from "./invoiceReviewLine";

function line(patch: Partial<InvoiceReviewLine> = {}): InvoiceReviewLine {
  return {
    key: 3, sourceLineIndex: 0, sourceDescription: "REF 040 ARROZ", ingredientId: "rice", ingredientName: "Arroz",
    measureKind: "mass", suggestedPresentation: { supplierItemId: "bag", presentationLabel: "Bulto", contentQty: 25000, lastPriceCents: null },
    qtyMode: "presentation", presentations: "2", qty: "2", unit: "kg", cost: "10000", amountKind: "unit",
    taxBasis: "net", taxPct: 0, taxAmount: "", incAmount: "", lowConfidence: false, readUnit: "bulto", readQty: 2,
    ...patch,
  };
}

describe("reviewed supplier ingredient associations", () => {
  it("remembers an explicit existing ingredient selection and retains the immutable source index", () => {
    const original = line();
    const selected = chooseInvoiceIngredient(original, { id: "flour", name: "Harina", measureKind: "mass" });
    expect(selected).toMatchObject({ ingredientId: "flour", sourceLineIndex: 0, sourceDescription: "REF 040 ARROZ", rememberMatch: true, manuallySelected: true });
    expect(reviewLineAmounts(selected)?.totalCents).toBe(2000000);
    expect(reviewLineQtyBase(selected)).toBe(50000);
    expect(original.ingredientId).toBe("rice");
  });
  it("can confirm the same ingredient explicitly without changing its quantity or price", () => {
    const selected = chooseInvoiceIngredient(line(), { id: "rice", name: "Arroz", measureKind: "mass" });
    expect(selected).toMatchObject({ rememberMatch: true, qtyMode: "presentation", cost: "10000" });
  });
  it("never remembers a manual added line or a new ingredient", () => {
    expect(chooseInvoiceIngredient(line({ sourceLineIndex: undefined }), { id: "flour", name: "Harina", measureKind: "mass" }).rememberMatch).toBe(false);
    expect(chooseInvoiceIngredient(line({ sourceDescription: " " }), { id: "flour", name: "Harina", measureKind: "mass" }).rememberMatch).toBe(false);
    expect(chooseInvoiceIngredient(line({ aliasUnavailable: true }), { id: null, name: "Harina nueva", measureKind: "mass" })).toMatchObject({ rememberMatch: false, aliasUnavailable: false });
  });
  it("removes an automatic old supplier association while preserving the reviewed total and physical quantity", () => {
    const reset = resetInvoiceSupplier(line({ matchSource: "alias", rememberMatch: true }));
    expect(reset).toMatchObject({ ingredientId: null, ingredientName: "REF 040 ARROZ", rememberMatch: false, suggestedPresentation: null, qtyMode: "direct", cost: "20000", qty: "50" });
    expect(reset.matchSource).toBeUndefined();
    expect(reviewLineQtyBase(reset)).toBe(50000);
  });
  it("keeps a manual ingredient on supplier change but does not silently learn it for the new supplier", () => {
    const reset = resetInvoiceSupplier(chooseInvoiceIngredient(line(), { id: "flour", name: "Harina", measureKind: "mass" }));
    expect(reset).toMatchObject({ ingredientId: "flour", manuallySelected: true, rememberMatch: false });
    expect(applyInvoiceSupplierMatch(reset, { ingredient: { kind: "matched", ingredient: { id: "rice", name: "Arroz", measureKind: "mass" } }, matchSource: "alias" })).toEqual(reset);
  });
  it("applies a new supplier's alias without changing amounts or creating a new learning instruction", () => {
    const reset = resetInvoiceSupplier(line({ matchSource: "alias" }));
    const applied = applyInvoiceSupplierMatch(reset, { ingredient: { kind: "matched", ingredient: { id: "flour", name: "Harina", measureKind: "mass" } }, matchSource: "alias" });
    expect(applied).toMatchObject({ ingredientId: "flour", matchSource: "alias", rememberMatch: false, cost: "20000", qty: "50" });
  });
  it("requires choosing an archived association's replacement and does not touch manually added rows", () => {
    const match = { ingredient: { kind: "suggest_create" as const, name: "REF 040 ARROZ" }, aliasUnavailable: true };
    expect(applyInvoiceSupplierMatch(resetInvoiceSupplier(line()), match)).toMatchObject({ ingredientId: null, aliasUnavailable: true });
    const manual = line({ sourceLineIndex: undefined });
    expect(applyInvoiceSupplierMatch(manual, match)).toEqual(manual);
  });
});
