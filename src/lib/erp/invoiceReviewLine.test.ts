import { describe, expect, it } from "vitest";
import { resolveReviewInvoice, reviewLineAmounts, reviewLineDiscountDetail, reviewLineQtyBase, selectReviewIngredient, setReviewTaxIncluded, type InvoiceReviewLine } from "./invoiceReviewLine";
import { discountsReproduceNet, resolveOrderDiscounts } from "./purchaseDiscount";

function line(patch: Partial<InvoiceReviewLine> = {}): InvoiceReviewLine {
  return {
    key: 5, ingredientId: "rice", ingredientName: "Arroz", measureKind: "mass",
    suggestedPresentation: { supplierItemId: "rice-bag", presentationLabel: "Bulto", contentQty: 25000, lastPriceCents: null },
    qtyMode: "presentation", presentations: "2", qty: "2", unit: "kg",
    cost: "98750", taxPct: 19, amountKind: "line", taxBasis: "net", taxAmount: "", incAmount: "",
    lowConfidence: false, readUnit: "kg", readQty: 2,
    ...patch,
  };
}

describe("edited invoice ingredient quantities", () => {
  it("lets the operator toggle included VAT both ways without changing the printed amount or quantity", () => {
    const original = line({ cost: "11900", taxPct: 19, taxBasis: "net", taxAmount: "2261" });
    const included = setReviewTaxIncluded(original, true);
    expect(included).toMatchObject({ cost: "11900", presentations: "2", taxBasis: "gross", taxBasisManual: true, taxAmount: "" });
    expect(reviewLineAmounts(included)).toEqual({ netCents: 1000000, taxCents: 190000, incCents: 0, totalCents: 1190000 });
    const excluded = setReviewTaxIncluded(included, false);
    expect(reviewLineAmounts(excluded)).toEqual({ netCents: 1190000, taxCents: 226100, incCents: 0, totalCents: 1416100 });
    expect(original).toMatchObject({ taxBasis: "net", taxAmount: "2261" });
  });
  it("preserves documentary VAT when confirming the same basis and keeps fixed consumption on a change", () => {
    const original = line({ cost: "138850", taxBasis: "gross", taxPct: 5, taxAmount: "4242", incAmount: "49774" });
    expect(setReviewTaxIncluded(original, true)).toMatchObject({ taxAmount: "4242", incAmount: "49774", taxBasisManual: true });
    const changed = setReviewTaxIncluded(original, false);
    expect(changed).toMatchObject({ taxAmount: "", incAmount: "49774", cost: "138850" });
    expect(reviewLineAmounts(changed)).toEqual({ netCents: 13885000, taxCents: 694250, incCents: 4977400, totalCents: 19556650 });
  });
  it.each([true, false])("resolves an unknown basis explicitly: included=%s", included => {
    const resolved = setReviewTaxIncluded(line({ taxBasis: "unknown" }), included);
    expect(resolved.taxBasis).toBe(included ? "gross" : "net");
    expect(resolved.taxBasisManual).toBe(true);
    expect(reviewLineAmounts(resolved)).not.toBeNull();
    expect(selectReviewIngredient(resolved, { id: "flour", name: "Harina", measureKind: "mass" }))
      .toMatchObject({ taxBasis: resolved.taxBasis, taxBasisManual: true });
  });
  it.each([
    { included: true, cost: "89076.29" },
    { included: false, cost: "84834.29" },
  ])("preserves rounded documentary VAT when resolving unknown: included=$included", ({ included, cost }) => {
    const original = line({ cost, taxBasis: "unknown", taxPct: 5, taxAmount: "4242" });
    const resolved = setReviewTaxIncluded(original, included);
    expect(resolved.taxAmount).toBe("4242");
    expect(reviewLineAmounts(resolved)).toEqual({ netCents: 8483429, taxCents: 424200, incCents: 0, totalCents: 8907629 });
    expect(original.taxBasis).toBe("unknown");
  });
  it("keeps line totals independent of quantity edits and uses explicit included taxes", () => {
    const l = line({ cost: "138850", taxPct: 5, taxBasis: "gross", incAmount: "49774" });
    expect(reviewLineAmounts(l)?.totalCents).toBe(13885000);
    expect(reviewLineAmounts({ ...l, presentations: "4" })?.totalCents).toBe(13885000);
    expect(reviewLineAmounts({ ...l, amountKind: "unit", cost: "69425" })?.totalCents).toBe(13885000);
  });
  it("requires review of unknown tax bases, missing rates, and ambiguous consumption", () => {
    expect(reviewLineAmounts(line({ taxBasis: "unknown" }))).toBeNull();
    expect(reviewLineAmounts(line({ taxPct: null }))).toBeNull();
    expect(reviewLineAmounts(line({ incNeedsReview: true }))).toBeNull();
    expect(reviewLineAmounts(line({ incNeedsReview: true, incAmount: "0" }))?.incCents).toBe(0);
    expect(reviewLineAmounts(line({ cost: "" }))).toBeNull();
    expect(reviewLineAmounts(line({ taxAmount: "bad" }))).toBeNull();
    expect(reviewLineAmounts(line({ incAmount: "-1" }))).toBeNull();
  });
  it("converts unit pricing to a fixed total when changing a suggested presentation", () => {
    const updated = selectReviewIngredient(line({ amountKind: "unit", cost: "10000" }), { id: "flour", name: "Harina", measureKind: "mass" });
    expect(updated).toMatchObject({ amountKind: "line", cost: "20000", qty: "50" });
    expect(reviewLineAmounts(updated)?.netCents).toBe(2000000);
  });
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

describe("supplier discounts in the invoice review", () => {
  const plain = (patch: Partial<InvoiceReviewLine> = {}) =>
    line({ suggestedPresentation: null, qtyMode: "direct", qty: "2", unit: "un", measureKind: "count", ...patch });

  it("applies a line % to the typed line amount and computes automatic VAT on the discounted base", () => {
    const l = plain({ cost: "20000", discRaw: "10", discIsPct: true });
    expect(reviewLineAmounts(l)).toEqual({ netCents: 1_800_000, taxCents: 342_000, incCents: 0, totalCents: 2_142_000 });
    expect(reviewLineDiscountDetail(l)).toEqual({ listCents: 2_000_000, discount: { pct: 10, cents: null }, shownListCents: 2_000_000, shownDiscountCents: 200_000 });
  });
  it("multiplies a unit price once before a fixed-value line discount", () => {
    const l = plain({ amountKind: "unit", cost: "10000", discRaw: "1500", discIsPct: false });
    expect(reviewLineAmounts(l)?.netCents).toBe(1_850_000);
    expect(reviewLineDiscountDetail(l)?.discount).toEqual({ pct: null, cents: 150_000 });
  });
  it("keeps a printed line VAT even with a discount", () => {
    expect(reviewLineAmounts(plain({ cost: "20000", discRaw: "10", taxAmount: "3800" }))?.taxCents).toBe(380_000);
  });
  it("discounts a tax-included amount and persists its pre-tax equivalent", () => {
    const l = plain({ cost: "23800", taxBasis: "gross", discRaw: "10" });
    const amounts = reviewLineAmounts(l)!;
    expect(amounts).toEqual({ netCents: 1_800_000, taxCents: 342_000, incCents: 0, totalCents: 2_142_000 });
    const detail = reviewLineDiscountDetail(l, amounts)!;
    expect(detail).toMatchObject({ listCents: 2_000_000, discount: { pct: null, cents: 200_000 }, shownListCents: 2_380_000, shownDiscountCents: 238_000 });
  });
  it("leaves lines without discount exactly as before", () => {
    const l = plain({ cost: "20000" });
    expect(reviewLineAmounts(l)).toEqual(reviewLineAmounts({ ...l, discRaw: "", discIsPct: true }));
    expect(reviewLineDiscountDetail(l)).toMatchObject({ listCents: 2_000_000, discount: { pct: null, cents: null }, shownDiscountCents: 0 });
  });
  it("prorates the document discount, recomputes automatic VAT on the discounted base and keeps printed VAT", () => {
    const resolved = resolveReviewInvoice([
      plain({ cost: "60000" }),
      plain({ cost: "40000", taxPct: 5, taxAmount: "2000" }),
    ], { pct: 10 });
    expect(resolved.lines.map(l => [l?.orderDiscountCents, l?.netCents, l?.taxCents])).toEqual([
      [600_000, 5_400_000, 1_026_000],
      [400_000, 3_600_000, 200_000],
    ]);
    expect(resolved).toMatchObject({ subtotalCents: 10_000_000, discountCents: 1_000_000, netCents: 9_000_000, taxCents: 1_226_000, totalCents: 10_226_000, orderDiscount: { pct: 10, cents: null }, complete: true });
  });
  it("produces the list and discounts that the server reproduces exactly", () => {
    const lines = [
      plain({ cost: "33333.33", discRaw: "12,5" }),
      plain({ cost: "23800", taxBasis: "gross", discRaw: "777", discIsPct: false }),
      plain({ amountKind: "unit", cost: "999.99", qty: "3" }),
    ];
    const resolved = resolveReviewInvoice(lines, { pct: 7.5 });
    expect(resolved.complete).toBe(true);
    expect(resolved.orderDiscount.pct).toBeNull();
    expect(discountsReproduceNet(resolved.lines.map(l => ({ netCents: l!.netCents, listCents: l!.listCents,
      discount: { pct: l!.discountPct, cents: l!.discountCents } })), resolved.orderDiscount)).toBe(true);
    const applied = resolveOrderDiscounts(resolved.lines.map(l => ({ listCents: l!.listCents, discount: { pct: l!.discountPct, cents: l!.discountCents } })), resolved.orderDiscount);
    expect(applied.lines.map(l => l.netCents)).toEqual(resolved.lines.map(l => l!.netCents));
  });
  it("does not give a document discount share to incomplete lines", () => {
    const resolved = resolveReviewInvoice([plain({ cost: "10000" }), plain({ taxBasis: "unknown" })], { cents: 100_000 });
    expect(resolved.complete).toBe(false);
    expect(resolved.lines[0]?.orderDiscountCents).toBe(100_000);
    expect(resolved.lines[1]).toBeNull();
  });
});
