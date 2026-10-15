import { describe, expect, it } from "vitest";
import { reviewLineQtyBase, selectReviewIngredient, type InvoiceReviewLine } from "./invoiceReviewLine";

function line(patch: Partial<InvoiceReviewLine> = {}): InvoiceReviewLine {
  return {
    key: 5, ingredientId: "rice", ingredientName: "Arroz", measureKind: "mass",
    suggestedPresentation: { supplierItemId: "rice-bag", presentationLabel: "Bulto", contentQty: 25000, lastPriceCents: null },
    qtyMode: "presentation", presentations: "2", qty: "2", unit: "kg",
    cost: "98750", taxPct: 19, lowConfidence: false, readUnit: "kg", readQty: 2,
    ...patch,
  };
}

describe("edited invoice ingredient quantities", () => {
  it("releases the old presentation when choosing a different ingredient", () => {
    const original = line();
    const updated = selectReviewIngredient(original, { id: "flour", name: "Harina", measureKind: "mass" });
    expect(updated).toMatchObject({ ingredientId: "flour", ingredientName: "Harina", qtyMode: "direct", suggestedPresentation: null, qty: "50", unit: "kg", cost: "98750", taxPct: 19, key: 5 });
    expect(reviewLineQtyBase(updated)).toBe(50000);
    expect(original.suggestedPresentation?.supplierItemId).toBe("rice-bag");
  });
  it("keeps direct edits in the same measurement dimension", () => {
    const original = line({ qtyMode: "direct", qty: "750", unit: "g" });
    const updated = selectReviewIngredient(original, { id: "flour", name: "Harina", measureKind: "mass" });
    expect(updated).toMatchObject({ qty: "750", unit: "g", suggestedPresentation: null });
    expect(reviewLineQtyBase(updated)).toBe(750);
  });
  it("requires an explicit quantity instead of converting mass into units", () => {
    const updated = selectReviewIngredient(line(), { id: "eggs", name: "Huevos", measureKind: "count" });
    expect(updated).toMatchObject({ measureKind: "count", unit: "un", qty: "", suggestedPresentation: null, qtyMode: "direct" });
    expect(reviewLineQtyBase(updated)).toBeNull();
    expect(reviewLineQtyBase({ ...updated, qty: "12" })).toBe(12000);
  });
  it("lets an incorrect match become a new ingredient without resetting edited cost or tax", () => {
    const updated = selectReviewIngredient(line(), { id: null, name: "Harina nueva", measureKind: "mass" });
    expect(updated).toMatchObject({ ingredientId: null, ingredientName: "Harina nueva", qty: "50", cost: "98750", taxPct: 19, qtyMode: "direct", suggestedPresentation: null });
  });
  it("keeps a valid presentation when selecting the same ingredient", () => {
    const original = line();
    expect(selectReviewIngredient(original, { id: "rice", name: "Arroz", measureKind: "mass" })).toEqual(original);
  });
  it("converts volume presentations to direct quantities accurately", () => {
    const updated = selectReviewIngredient(line({ measureKind: "volume", unit: "L", suggestedPresentation: { supplierItemId: "bottle", presentationLabel: "Botella", contentQty: 750, lastPriceCents: null } }), { id: "oil", name: "Aceite", measureKind: "volume" });
    expect(updated.qty).toBe("1500");
    expect(updated.unit).toBe("ml");
    expect(reviewLineQtyBase(updated)).toBe(1500);
  });
  it("keeps an invalid presentation blank instead of falling back to the old OCR quantity", () => {
    const updated = selectReviewIngredient(line({ presentations: "" }), { id: "flour", name: "Harina", measureKind: "mass" });
    expect(updated.qty).toBe("");
    expect(reviewLineQtyBase(updated)).toBeNull();
  });
  it.each(["", "0", "-1", "2.5", "Infinity", "1000000"])("rejects invalid or excessive presentation quantity %s", presentations => {
    expect(reviewLineQtyBase(line({ presentations }))).toBeNull();
  });
  it.each(["0", "-4", "oops", "Infinity"])("rejects invalid direct quantity %s", qty => {
    expect(reviewLineQtyBase(line({ qtyMode: "direct", qty }))).toBeNull();
  });
  it("accepts comma decimals and falls back to direct quantity when there is no presentation", () => {
    expect(reviewLineQtyBase(line({ qty: "2,75", suggestedPresentation: null }))).toBe(2750);
  });
});
