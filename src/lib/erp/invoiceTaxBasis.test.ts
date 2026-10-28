import { describe, expect, it } from "vitest";
import { inferPurchaseInvoiceTaxBases, type InvoiceTaxDocument, type InvoiceTaxLine } from "./invoiceTaxBasis";
import { initialInvoicePrice } from "./invoiceAmounts";

const line = (fields: Partial<InvoiceTaxLine> = {}): InvoiceTaxLine => ({
  quantity: 2, unitPriceCents: null, lineTotalCents: 23_800, taxPct: "19",
  unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown",
  unitPriceLabel: null, lineTotalLabel: null, lineTaxCents: null,
  lineIncCents: null, lineIncAmbiguous: false, ...fields,
});
const invoice = (fields: Partial<InvoiceTaxDocument> = {}): InvoiceTaxDocument => ({
  lines: [line()], invoiceSubtotalCents: null, invoiceDiscountCents: null,
  invoiceTaxCents: null, invoiceTotalCents: null, invoiceIncCents: null,
  retefuenteCents: null, reteIvaCents: null, reteIcaCents: null, ...fields,
});
const inferLine = (fields: Partial<InvoiceTaxLine>) => inferPurchaseInvoiceTaxBases(invoice({ lines: [line(fields)] })).lines[0];

describe("printed purchase invoice tax bases", () => {
  it.each([
    ["Total con IVA", "gross"], ["IVA INCLUIDO", "gross"], ["Impuestos incluidos", "gross"],
    ["Precio incluye IVA", "gross"],
    ["Total antes de impuestos", "net"], ["P. UNIT ANTES IMPTO", "net"],
    ["Valor sin IVA", "net"], ["No incluye IVA", "net"], ["IVA no incluido", "net"],
    ["No incluye el IVA", "net"], ["No incluye los impuestos", "net"],
    ["Total not including VAT", "net"], ["VAT not included", "net"],
    ["Preço não inclui o IVA", "net"], ["Impostos não incluídos", "net"],
    ["Price without VAT", "net"],
    ["Base imponible", "net"], ["Base gravable", "net"],
    ["Total including VAT", "gross"], ["Price excluding tax", "net"],
    ["Valor com impostos", "gross"], ["Preço sem IVA", "net"],
  ] as const)("recognizes explicit column %s", (lineTotalLabel, expected) => {
    expect(inferLine({ lineTotalLabel }).lineTotalTaxBasis).toBe(expected);
  });

  it.each(["Total", "Neto", "Valor neto", "Precio", "IVA 19%", "Con descuento", "Precio sugerido",
    "VLR NETO FINAL", "P. FINAL UNIT", "Neto después de descuento", "Precio no viene con IVA"])("keeps the ambiguous label %s for review", lineTotalLabel => {
    expect(inferLine({ lineTotalLabel }).lineTotalTaxBasis).toBe("unknown");
  });

  it("keeps the unit and total bases independent on mixed supplier layouts", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ lines: [
      line({ unitPriceCents: 10_000, unitPriceLabel: "P. UNIT ANTES IMPTO", lineTotalLabel: "Total IVA incluido" }),
      line({ lineTotalCents: 20_000, lineTotalLabel: "Valor sin IVA" }),
    ] }));
    expect(result.lines.map(l => [l.unitPriceTaxBasis, l.lineTotalTaxBasis])).toEqual([
      ["net", "gross"], ["unknown", "net"],
    ]);
  });

  it("preserves the mandatory consumption review for legacy uploads without tax metadata", () => {
    const legacy = line({ unitPriceCents: 10_000, lineTaxCents: 3_800,
      unitPriceTaxBasis: undefined, lineTotalTaxBasis: undefined, lineIncCents: undefined, lineIncAmbiguous: undefined });
    const input = invoice({ lines: [legacy], invoiceSubtotalCents: 20_000, invoiceTaxCents: 3_800, invoiceTotalCents: 23_800 });
    const result = inferPurchaseInvoiceTaxBases(input);
    expect(result.lines[0]).toMatchObject({ lineIncAmbiguous: true, unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown" });
    expect(initialInvoicePrice(result.lines[0]).incNeedsReview).toBe(true);
    expect(inferPurchaseInvoiceTaxBases(result)).toEqual(result);
    expect(input.lines[0].lineIncAmbiguous).toBeUndefined();
  });

  it("can retain a legacy printed label while still requiring consumption review", () => {
    const result = inferLine({ unitPriceTaxBasis: undefined, lineTotalTaxBasis: undefined,
      lineIncCents: undefined, lineTotalLabel: "Total con IVA" });
    expect(result).toMatchObject({ lineTotalTaxBasis: "gross", lineIncAmbiguous: true });
    expect(initialInvoicePrice(result).incNeedsReview).toBe(true);
  });

  it("requires review when transcribed labels and reported classification disagree", () => {
    expect(inferLine({ lineTotalLabel: "Con IVA", lineTotalTaxBasis: "net" }).lineTotalTaxBasis).toBe("unknown");
    expect(inferLine({ lineTotalLabel: "Con IVA / Sin IVA" }).lineTotalTaxBasis).toBe("unknown");
  });

  it("retains an extracted basis when no contradictory evidence is available", () => {
    expect(inferLine({ lineTotalTaxBasis: "gross" }).lineTotalTaxBasis).toBe("gross");
    expect(inferLine({ lineTotalTaxBasis: "net" }).lineTotalTaxBasis).toBe("net");
  });

  it("does not infer missing price fields from labels or duplicate another field's basis", () => {
    expect(inferLine({ unitPriceCents: null, unitPriceLabel: "Precio con IVA" }).unitPriceTaxBasis).toBe("unknown");
    expect(inferLine({ lineTotalCents: null, lineTotalLabel: "Total sin IVA" }).lineTotalTaxBasis).toBe("unknown");
  });
});

describe("line arithmetic corroborates printed taxes without changing amounts", () => {
  it("detects gross and net line prices from an explicit line IVA amount", () => {
    expect(inferLine({ lineTaxCents: 3_800 }).lineTotalTaxBasis).toBe("gross");
    expect(inferLine({ lineTotalCents: 20_000, lineTaxCents: 3_800 }).lineTotalTaxBasis).toBe("net");
  });

  it("uses line IVA once for a unit price and a fractional quantity", () => {
    expect(inferLine({ quantity: 2.5, unitPriceCents: 11_900, lineTotalCents: null, lineTaxCents: 4_750 }).unitPriceTaxBasis).toBe("gross");
    expect(inferLine({ quantity: 2.5, unitPriceCents: 10_000, lineTotalCents: null, lineTaxCents: 4_750 }).unitPriceTaxBasis).toBe("net");
  });

  it("recognizes a net unit alongside a gross line total and the reverse", () => {
    expect(inferLine({ unitPriceCents: 10_000 })).toMatchObject({ unitPriceTaxBasis: "net", lineTotalTaxBasis: "gross" });
    expect(inferLine({ unitPriceCents: 11_900, lineTotalCents: 20_000 })).toMatchObject({ unitPriceTaxBasis: "gross", lineTotalTaxBasis: "net" });
  });

  it("propagates the same basis only when quantity and amount reconcile", () => {
    expect(inferLine({ unitPriceCents: 11_900, lineTotalLabel: "IVA incluido" })).toMatchObject({ unitPriceTaxBasis: "gross", lineTotalTaxBasis: "gross" });
    expect(inferLine({ unitPriceCents: 11_900 })).toMatchObject({ unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown" });
  });

  it("does not mistake different columns caused by discounts for tax evidence", () => {
    expect(inferLine({ unitPriceCents: 15_000, lineTotalCents: 20_000 })).toMatchObject({ unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown" });
  });

  it("does not assume a VAT percentage alone means a net or gross amount", () => {
    expect(inferLine({ taxPct: "5 %" }).lineTotalTaxBasis).toBe("unknown");
    expect(inferLine({ lineTaxCents: 3_800, taxPct: null }).lineTotalTaxBasis).toBe("unknown");
    expect(inferLine({ lineTaxCents: 3_800, taxPct: "IVA 5 / 19" }).lineTotalTaxBasis).toBe("unknown");
  });

  it("requires review for contradictory printed IVA rather than retaining a dangerous basis", () => {
    expect(inferLine({ lineTotalLabel: "Total antes de impuestos", lineTaxCents: 3_800 }).lineTotalTaxBasis).toBe("unknown");
  });

  it("does not resolve an equal zero-tax candidate arbitrarily", () => {
    expect(inferLine({ taxPct: "0", lineTaxCents: 0 }).lineTotalTaxBasis).toBe("unknown");
    expect(inferLine({ lineTotalCents: 0, taxPct: "19", lineTaxCents: 0 }).lineTotalTaxBasis).toBe("unknown");
  });

  it("resolves the reported Gordon layout from printed IVA and consumption, not a generic final/net label", () => {
    expect(inferLine({ quantity: 2, unitPriceCents: 4_241_700, lineTotalCents: 13_885_000,
      unitPriceLabel: "P. UNIT ANTES IMPTO", lineTotalLabel: "VLR NETO FINAL",
      taxPct: "5", lineTaxCents: 424_200, lineIncCents: 4_977_400 }))
      .toMatchObject({ unitPriceTaxBasis: "net", lineTotalTaxBasis: "gross" });
  });

  it("allows a final column to be net when printed line IVA corroborates a post-discount base", () => {
    expect(inferLine({ lineTotalLabel: "VLR NETO FINAL", lineTotalCents: 20_000, lineTaxCents: 3_800 }).lineTotalTaxBasis).toBe("net");
    expect(inferLine({ unitPriceLabel: "P. FINAL UNIT", unitPriceCents: 10_000, lineTotalCents: null, lineTaxCents: 3_800 }).unitPriceTaxBasis).toBe("net");
  });

  it("preserves fixed consumption separately when gross prices include IVA and consumption", () => {
    expect(inferLine({ lineTotalCents: 13_885_000, taxPct: "5", lineTaxCents: 424_200, lineIncCents: 4_977_400 }).lineTotalTaxBasis).toBe("gross");
    expect(inferLine({ unitPriceCents: 4_241_700, lineTotalCents: 13_884_970, taxPct: "5", lineIncCents: 4_977_400 }))
      .toMatchObject({ unitPriceTaxBasis: "net", lineTotalTaxBasis: "gross" });
  });

  it("does not infer an unknown consumption amount from the final price", () => {
    expect(inferLine({ unitPriceCents: 10_000, lineTaxCents: 3_800, lineIncAmbiguous: true }))
      .toMatchObject({ unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown" });
    expect(inferLine({ lineTotalLabel: "Total con impuestos", lineIncAmbiguous: true }).lineTotalTaxBasis).toBe("gross");
  });

  it.each([
    { quantity: 0 }, { quantity: NaN }, { quantity: -2 }, { quantity: Infinity },
    { lineTotalCents: -1 }, { lineTotalCents: 23_800.5 }, { lineTotalCents: Number.MAX_SAFE_INTEGER },
    { lineTaxCents: -1 }, { lineTaxCents: NaN }, { lineIncCents: -1 },
  ])("does not infer from invalid numbers %j", fields => {
    expect(inferLine({ lineTaxCents: 3_800, ...fields }).lineTotalTaxBasis).toBe("unknown");
  });
});

describe("printed document totals settle a uniform invoice basis", () => {
  const netLines = [line({ lineTotalCents: 10_000, taxPct: "19" }), line({ lineTotalCents: 20_000, taxPct: "5" })];
  const grossLines = [line({ lineTotalCents: 11_900, taxPct: "19" }), line({ lineTotalCents: 21_000, taxPct: "5" })];
  const summary = { invoiceSubtotalCents: 30_000, invoiceTaxCents: 2_900, invoiceTotalCents: 32_900 };

  it.each([["net", netLines], ["gross", grossLines]] as const)("identifies %s from footer totals without model metadata", (basis, lines) => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual([basis, basis]);
  });

  it("supports an invoice with unit prices only without multiplying an already-total line", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: [
      line({ quantity: 2, unitPriceCents: 5_950, lineTotalCents: null, taxPct: "19" }),
      line({ quantity: 4, lineTotalCents: 21_000, taxPct: "5" }),
    ] }));
    expect(result.lines[0].unitPriceTaxBasis).toBe("gross");
    expect(result.lines[1].lineTotalTaxBasis).toBe("gross");
  });

  it("validates retentions against the amount actually payable", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: grossLines,
      invoiceTotalCents: 31_000, retefuenteCents: 1_000, reteIvaCents: 700, reteIcaCents: 200 }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["gross", "gross"]);
  });

  it("recognizes the before-discount subtotal without applying the discount a second time", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: grossLines,
      invoiceSubtotalCents: 35_000, invoiceDiscountCents: 5_000 }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["gross", "gross"]);
    expect(result.invoiceDiscountCents).toBe(5_000);
  });

  it("also accepts a printed subtotal already after the separately printed discount", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: netLines, invoiceDiscountCents: 5_000 }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["net", "net"]);
  });

  it("keeps explicit documentary IVA unchanged and never adds it to line IVA", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: grossLines }));
    expect(result.invoiceTaxCents).toBe(2_900);
    expect(result.lines.map(l => l.lineTaxCents)).toEqual([null, null]);
  });

  it("supports mixed invoices from per-line evidence, without forcing a uniform footer convention", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: [
      line({ lineTotalCents: 11_900, taxPct: "19", lineTotalLabel: "Con IVA" }),
      line({ lineTotalCents: 20_000, taxPct: "5", lineTotalLabel: "Sin IVA" }),
    ] }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["gross", "net"]);
  });

  it.each([
    ["gross", 11_900, "net", "Sin IVA"],
    ["net", 10_000, "gross", "IVA incluido"],
  ] as const)("does not make a %s footer convention contradict an equivalent exempt line", (taxableBasis, taxableAmount, exemptBasis, label) => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ lines: [
      line({ lineTotalCents: taxableAmount, taxPct: "19" }),
      line({ lineTotalCents: 20_000, taxPct: "0", lineTotalLabel: label, lineTotalTaxBasis: exemptBasis }),
    ], invoiceSubtotalCents: 30_000, invoiceTaxCents: 1_900, invoiceTotalCents: 31_900 }));
    expect(result.lines[0].lineTotalTaxBasis).toBe(taxableBasis);
    expect(result.lines[1].lineTotalTaxBasis).toBe(exemptBasis);
    expect(result.lines[1].lineTotalTaxBasisConflict).toBeUndefined();
    expect(inferPurchaseInvoiceTaxBases(result)).toEqual(result);
  });

  it("does not solve an arbitrary mixed-basis subset merely to make invoice totals fit", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: [grossLines[0], netLines[1]] }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["unknown", "unknown"]);
  });

  it("leaves an internally conflicting model classification for manual review", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: grossLines.map(l => ({ ...l, lineTotalTaxBasis: "net" as const })) }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["unknown", "unknown"]);
  });

  it("does not let footer evidence erase an existing local conflict", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: [
      { ...grossLines[0], lineTotalLabel: "Sin IVA", lineTaxCents: 1_900 }, grossLines[1],
    ] }));
    expect(result.lines[0].lineTotalTaxBasis).toBe("unknown");
  });

  it.each([
    { invoiceTaxCents: 2_920, invoiceTotalCents: 32_920 },
    { invoiceTotalCents: 40_000 }, { invoiceSubtotalCents: 40_000 },
    { invoiceIncCents: 3_000 }, { retefuenteCents: -1 },
  ])("does not infer from inconsistent or incomplete totals %j", fields => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, ...fields, lines: grossLines }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["unknown", "unknown"]);
  });

  it("uses at most cent rounding, not a percentage tolerance that can conceal a wrong price", () => {
    expect(inferPurchaseInvoiceTaxBases(invoice({ ...summary, invoiceTaxCents: 2_902, lines: grossLines })).lines[0].lineTotalTaxBasis).toBe("unknown");
  });

  it("does not guess from one isolated footer value or a missing product amount", () => {
    expect(inferPurchaseInvoiceTaxBases(invoice({ lines: grossLines, invoiceTotalCents: 32_900 })).lines[0].lineTotalTaxBasis).toBe("unknown");
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: [...grossLines, line({ lineTotalCents: null })] }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("does not guess when an extracted consumption column is ambiguous", () => {
    const result = inferPurchaseInvoiceTaxBases(invoice({ ...summary, lines: grossLines.map(l => ({ ...l, lineIncAmbiguous: true })) }));
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["unknown", "unknown"]);
  });

  it("reconciles fixed consumption only when its line amounts account for the document total", () => {
    const input = invoice({ lines: [line({ lineTotalCents: 25_800, taxPct: "19", lineIncCents: 2_000 })],
      invoiceSubtotalCents: 20_000, invoiceTaxCents: 3_800, invoiceIncCents: 2_000, invoiceTotalCents: 25_800 });
    expect(inferPurchaseInvoiceTaxBases(input).lines[0].lineTotalTaxBasis).toBe("gross");
    expect(inferPurchaseInvoiceTaxBases({ ...input, lines: [line({ lineTotalCents: 25_800 })] }).lines[0].lineTotalTaxBasis).toBe("unknown");
  });

  it("leaves zero-rated footer-equivalent interpretations for review", () => {
    expect(inferPurchaseInvoiceTaxBases(invoice({ lines: [line({ lineTotalCents: 20_000, taxPct: "0" })],
      invoiceSubtotalCents: 20_000, invoiceTaxCents: 0, invoiceTotalCents: 20_000 })).lines[0].lineTotalTaxBasis).toBe("unknown");
  });

  it("preserves every transcribed amount and metadata without mutating or removing unknown fields", () => {
    const input = { ...invoice({ ...summary, lines: grossLines }), supplierName: "Synthetic Supplier", custom: { id: "unchanged" } };
    const before = structuredClone(input);
    Object.freeze(input); Object.freeze(input.lines); input.lines.forEach(Object.freeze);
    const result = inferPurchaseInvoiceTaxBases(input);
    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(result.supplierName).toBe(input.supplierName);
    expect(result.custom).toBe(input.custom);
    const withoutBases = (l: InvoiceTaxLine) => ({ ...l, unitPriceTaxBasis: undefined, lineTotalTaxBasis: undefined });
    expect(result.lines.map(withoutBases)).toEqual(before.lines.map(withoutBases));
    expect(inferPurchaseInvoiceTaxBases(result)).toEqual(result);
    expect(inferPurchaseInvoiceTaxBases(invoice({ lines: [] })).lines).toEqual([]);
  });
});
