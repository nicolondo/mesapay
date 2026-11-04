import { describe, expect, it } from "vitest";
import { prefillInvoiceDiscounts, type InvoiceDiscountDocument, type InvoiceDiscountLine } from "./invoiceDiscount";
import { initialInvoicePrice, parseInvoiceTaxPct } from "./invoiceAmounts";
import { inferPurchaseInvoiceTaxBases } from "./invoiceTaxBasis";
import { resolveReviewInvoice, type InvoiceReviewLine } from "./invoiceReviewLine";
import { discountsReproduceNet, parseDiscountInput } from "./purchaseDiscount";

// Synthetic extractions only: these mimic what the extractor transcribes,
// no invoice is ever sent to an AI provider by these tests.
const line = (fields: Partial<InvoiceDiscountLine> = {}): InvoiceDiscountLine => ({
  quantity: 2, unitPriceCents: null, lineTotalCents: null, taxPct: "19",
  unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown",
  unitPriceLabel: null, lineTotalLabel: null, lineTaxCents: null,
  lineIncCents: 0, lineIncAmbiguous: false, ...fields,
});
const invoice = (lines: InvoiceDiscountLine[], fields: Partial<InvoiceDiscountDocument> = {}): InvoiceDiscountDocument => ({
  lines, invoiceSubtotalCents: null, invoiceDiscountCents: null, invoiceTaxCents: null,
  invoiceTotalCents: null, invoiceIncCents: null, retefuenteCents: null, reteIvaCents: null,
  reteIcaCents: null, ...fields,
});

/** Same construction as the review sheet: inference, initial price, prefill. */
function review(doc: InvoiceDiscountDocument) {
  const inferred = inferPurchaseInvoiceTaxBases(doc);
  const lines = inferred.lines.map((ext, i): InvoiceReviewLine => ({
    key: i, sourceLineIndex: i, ingredientId: `ingredient-${i}`, ingredientName: `Insumo ${i}`,
    measureKind: "count", suggestedPresentation: null, qtyMode: "direct", presentations: "1",
    qty: String(ext.quantity), unit: "un", ...initialInvoicePrice(ext),
    taxPct: parseInvoiceTaxPct(ext.taxPct), lowConfidence: false, readUnit: "un", readQty: ext.quantity,
  }));
  const extras = {
    incCents: Math.max(0, (doc.invoiceIncCents ?? 0) - doc.lines.reduce((s, l) => s + (l.lineIncCents ?? 0), 0)),
    retentionsCents: (doc.retefuenteCents ?? 0) + (doc.reteIvaCents ?? 0) + (doc.reteIcaCents ?? 0),
  };
  const prefill = prefillInvoiceDiscounts(inferred, lines, extras);
  const resolved = resolveReviewInvoice(prefill.lines, parseDiscountInput(prefill.orderDiscRaw, prefill.orderDiscIsPct));
  // Whatever is prefilled must be accepted by the server as-is.
  if (resolved.complete) {
    expect(discountsReproduceNet(resolved.lines.map(l => ({ netCents: l!.netCents, listCents: l!.listCents,
      discount: { pct: l!.discountPct, cents: l!.discountCents } })), resolved.orderDiscount)).toBe(true);
  }
  return { prefill, resolved, payable: resolved.totalCents + extras.incCents - extras.retentionsCents };
}

describe("supplier discount prefill never discounts twice", () => {
  it("keeps a net price that already contains the discount when the footer prints Total descuentos", () => {
    const { prefill, resolved, payable } = review(invoice([
      line({ unitPriceCents: 900_000, unitPriceLabel: "P. UNIT ANTES IMPTO", lineTotalCents: 1_800_000, lineTaxCents: 342_000 }),
    ], { invoiceSubtotalCents: 2_000_000, invoiceDiscountCents: 200_000, invoiceTaxCents: 342_000, invoiceTotalCents: 2_142_000 }));
    expect(prefill).toMatchObject({ orderDiscRaw: "", unplacedDiscountCents: null, taxBeforeDiscount: false });
    expect(prefill.lines[0]).toMatchObject({ cost: "18000" });
    expect(prefill.lines[0]?.discRaw).toBeUndefined();
    expect(resolved).toMatchObject({ netCents: 1_800_000, taxCents: 342_000, discountCents: 0 });
    expect(payable).toBe(2_142_000);
  });

  it("shows list price and line discount when both are printed, reaching the same printed net", () => {
    const { prefill, resolved, payable } = review(invoice([
      line({ listUnitPriceCents: 1_000_000, lineDiscountPct: 10, unitPriceCents: 900_000, unitPriceLabel: "P. UNIT ANTES IMPTO",
        lineTotalCents: 1_800_000, lineTaxCents: 342_000 }),
    ], { invoiceSubtotalCents: 2_000_000, invoiceDiscountCents: 200_000, invoiceTaxCents: 342_000, invoiceTotalCents: 2_142_000 }));
    expect(prefill.lines[0]).toMatchObject({ cost: "20000", amountKind: "line", taxBasis: "net", discRaw: "10", discIsPct: true, discountFromInvoice: true });
    // "Total descuentos" is the sum of the line discounts: no extra discount.
    expect(prefill.orderDiscRaw).toBe("");
    expect(resolved).toMatchObject({ subtotalCents: 2_000_000, lineDiscountCents: 200_000, orderDiscountCents: 0, netCents: 1_800_000, taxCents: 342_000 });
    expect(payable).toBe(2_142_000);
  });

  it("uses the exact value when the printed % does not reproduce the printed net", () => {
    const { prefill, resolved } = review(invoice([
      line({ quantity: 3, listUnitPriceCents: 3_333_300, lineDiscountPct: 10, lineTotalCents: 9_000_000, lineTotalLabel: "Valor sin IVA", taxPct: "0" }),
    ]));
    expect(prefill.lines[0]).toMatchObject({ cost: "99999", discRaw: "9999", discIsPct: false });
    expect(resolved.netCents).toBe(9_000_000);
  });

  it("applies the printed line discount when the only amount read is the list price", () => {
    const { prefill, resolved, payable } = review(invoice([
      line({ quantity: 3, unitPriceCents: 1_000_000, listUnitPriceCents: 1_000_000, unitPriceTaxBasis: "net", lineDiscountPct: 10 }),
    ], { invoiceSubtotalCents: 3_000_000, invoiceDiscountCents: 300_000, invoiceTaxCents: 513_000, invoiceTotalCents: 3_213_000 }));
    expect(prefill.lines[0]).toMatchObject({ cost: "30000", discRaw: "10", discIsPct: true, taxAmount: "" });
    expect(resolved).toMatchObject({ netCents: 2_700_000, taxCents: 513_000 });
    expect(payable).toBe(3_213_000);
    expect(prefill.orderDiscRaw).toBe("");
  });

  it("applies a document-only discount when the printed total proves it, with VAT on the discounted base", () => {
    const { prefill, resolved, payable } = review(invoice([
      line({ quantity: 1, lineTotalCents: 6_000_000, lineTotalTaxBasis: "net" }),
      line({ quantity: 1, lineTotalCents: 4_000_000, lineTotalTaxBasis: "net", taxPct: "5" }),
    ], { invoiceSubtotalCents: 10_000_000, invoiceDiscountCents: 1_000_000, invoiceTaxCents: 1_206_000, invoiceTotalCents: 10_206_000 }));
    expect(prefill).toMatchObject({ orderDiscRaw: "10000", orderDiscIsPct: false, orderDiscountFromInvoice: true, taxBeforeDiscount: false });
    expect(resolved.lines.map(l => [l?.orderDiscountCents, l?.netCents, l?.taxCents])).toEqual([
      [600_000, 5_400_000, 1_026_000], [400_000, 3_600_000, 180_000],
    ]);
    expect(payable).toBe(10_206_000);
  });

  it("keeps a document discount out when the printed total says the lines already include it", () => {
    const { prefill, payable } = review(invoice([
      line({ quantity: 1, lineTotalCents: 9_000_000, lineTotalTaxBasis: "net", taxPct: "0" }),
    ], { invoiceSubtotalCents: 10_000_000, invoiceDiscountCents: 1_000_000, invoiceTotalCents: 9_000_000 }));
    expect(prefill).toMatchObject({ orderDiscRaw: "", unplacedDiscountCents: null });
    expect(payable).toBe(9_000_000);
  });

  it("keeps the printed VAT when the supplier computed it before the discount, and flags it", () => {
    const { prefill, resolved, payable } = review(invoice([
      line({ quantity: 1, lineTotalCents: 6_000_000, lineTotalTaxBasis: "net" }),
      line({ quantity: 1, lineTotalCents: 4_000_000, lineTotalTaxBasis: "net", taxPct: "5" }),
    ], { invoiceSubtotalCents: 10_000_000, invoiceDiscountCents: 1_000_000, invoiceTaxCents: 1_340_000, invoiceTotalCents: 10_340_000 }));
    expect(prefill).toMatchObject({ orderDiscRaw: "10000", taxBeforeDiscount: true });
    expect(prefill.lines.map(l => [l.taxAmount, l.taxBeforeDiscount])).toEqual([["11400", true], ["2000", true]]);
    expect(resolved).toMatchObject({ netCents: 9_000_000, taxCents: 1_340_000 });
    expect(payable).toBe(10_340_000);
  });

  it("flags a printed line VAT computed on the undiscounted list price instead of recomputing it", () => {
    const { prefill, resolved } = review(invoice([
      line({ unitPriceCents: 1_000_000, listUnitPriceCents: 1_000_000, unitPriceTaxBasis: "net", lineDiscountPct: 10, lineTaxCents: 380_000 }),
    ]));
    expect(prefill.lines[0]).toMatchObject({ discRaw: "10", taxAmount: "3800", taxBeforeDiscount: true });
    expect(resolved).toMatchObject({ netCents: 1_800_000, taxCents: 380_000 });
  });

  it("keeps the footer VAT when it was computed on the list price of discounted lines", () => {
    const { prefill, resolved, payable } = review(invoice([
      line({ unitPriceCents: 1_000_000, listUnitPriceCents: 1_000_000, unitPriceTaxBasis: "net", lineDiscountPct: 10 }),
    ], { invoiceTaxCents: 380_000, invoiceTotalCents: 2_180_000 }));
    expect(prefill).toMatchObject({ taxBeforeDiscount: true });
    expect(prefill.lines[0]).toMatchObject({ taxAmount: "3800", taxBeforeDiscount: true });
    expect(resolved.taxCents).toBe(380_000);
    expect(payable).toBe(2_180_000);
  });

  it("does not discount fixed consumption (INC) and preserves the printed final total", () => {
    const { prefill, resolved, payable } = review(invoice([
      line({ listUnitPriceCents: 5_000_000, lineDiscountPct: 10, unitPriceCents: 4_500_000, unitPriceLabel: "P. UNIT ANTES IMPTO",
        lineTotalCents: 11_710_000, lineTotalLabel: "VLR NETO FINAL", lineTaxCents: 1_710_000, lineIncCents: 1_000_000 }),
    ], { invoiceSubtotalCents: 10_000_000, invoiceDiscountCents: 1_000_000, invoiceTaxCents: 1_710_000, invoiceIncCents: 1_000_000, invoiceTotalCents: 11_710_000 }));
    expect(prefill.lines[0]).toMatchObject({ cost: "100000", discRaw: "10", taxAmount: "17100", incAmount: "10000" });
    expect(resolved).toMatchObject({ netCents: 9_000_000, taxCents: 1_710_000, incCents: 1_000_000, totalCents: 11_710_000 });
    expect(payable).toBe(11_710_000);
    expect(prefill.orderDiscRaw).toBe("");
  });

  it("reconciles a document discount with retentions subtracted from the total", () => {
    const { prefill, payable } = review(invoice([
      line({ quantity: 1, lineTotalCents: 10_000_000, lineTotalTaxBasis: "net" }),
    ], { invoiceSubtotalCents: 10_000_000, invoiceDiscountCents: 1_000_000, invoiceTaxCents: 1_710_000,
      retefuenteCents: 225_000, invoiceTotalCents: 10_485_000 }));
    expect(prefill.orderDiscRaw).toBe("10000");
    expect(payable).toBe(10_485_000);
  });

  it.each([
    { total: 1_800_000, cost: "20000", discount: "10", net: 1_800_000, unmatched: false },
    { total: 2_000_000, cost: "10000", discount: undefined, net: 2_000_000, unmatched: false },
    { total: null, cost: "10000", discount: undefined, net: 2_000_000, unmatched: true },
  ])("decides an ambiguous unit price with the printed total ($total)", ({ total, cost, discount, net, unmatched }) => {
    const { prefill, resolved } = review(invoice([
      line({ unitPriceCents: 1_000_000, unitPriceTaxBasis: "net", lineDiscountPct: 10, taxPct: "0" }),
    ], { invoiceTotalCents: total }));
    expect(prefill.lines[0]).toMatchObject({ cost });
    expect(prefill.lines[0]?.discRaw).toBe(discount);
    expect(prefill.lines[0]?.discountUnmatched === true).toBe(unmatched);
    expect(resolved.netCents).toBe(net);
  });

  it("leaves a line discount that does not reconcile unapplied and flags it", () => {
    const { prefill, resolved } = review(invoice([
      line({ listUnitPriceCents: 1_000_000, lineDiscountPct: 10, lineTotalCents: 1_500_000, lineTotalTaxBasis: "net", taxPct: "0" }),
    ]));
    expect(prefill.lines[0]).toMatchObject({ cost: "15000", discountUnmatched: true });
    expect(resolved.netCents).toBe(1_500_000);
  });

  it("handles older uploads without discount fields: the footer discount is applied only with proof", () => {
    const lines = [line({ quantity: 1, lineTotalCents: 10_000_000, lineTotalTaxBasis: "net", taxPct: "0" })];
    expect(review(invoice(lines, { invoiceSubtotalCents: 10_000_000, invoiceDiscountCents: 1_000_000, invoiceTotalCents: 9_000_000 })).prefill.orderDiscRaw).toBe("10000");
    const noTotal = review(invoice(lines, { invoiceSubtotalCents: 10_000_000, invoiceDiscountCents: 1_000_000 }));
    expect(noTotal.prefill).toMatchObject({ orderDiscRaw: "", unplacedDiscountCents: 1_000_000 });
    expect(noTotal.resolved.netCents).toBe(10_000_000);
    const contradictory = review(invoice(lines, { invoiceDiscountCents: 1_000_000, invoiceTotalCents: 8_000_000 }));
    expect(contradictory.prefill).toMatchObject({ orderDiscRaw: "", unplacedDiscountCents: 1_000_000 });
  });

  it("does not touch lines or totals of invoices without any printed discount", () => {
    const doc = invoice([line({ lineTotalCents: 2_380_000, lineTaxCents: 380_000 })], { invoiceTotalCents: 2_380_000 });
    const { prefill, resolved } = review(doc);
    expect(prefill).toMatchObject({ orderDiscRaw: "", unplacedDiscountCents: null, taxBeforeDiscount: false });
    expect(prefill.lines[0]?.discRaw).toBeUndefined();
    expect(resolved).toMatchObject({ discountCents: 0, totalCents: 2_380_000 });
  });

  it("keeps unresolved tax bases for review instead of guessing a discount", () => {
    const { prefill, resolved } = review(invoice([
      line({ lineTotalCents: 1_800_000, listUnitPriceCents: 1_000_000, lineDiscountPct: 10 }),
    ], { invoiceDiscountCents: 200_000 }));
    expect(prefill.lines[0]).toMatchObject({ taxBasis: "unknown", discountUnmatched: true });
    expect(prefill.unplacedDiscountCents).toBe(200_000);
    expect(resolved.complete).toBe(false);
  });
});
