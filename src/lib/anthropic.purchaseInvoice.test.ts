import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { create: mock.create }; },
}));
vi.mock("./env", () => ({
  env: { ANTHROPIC_MODEL: "isolated-extraction-test" },
  requireAnthropicKey: () => "not-a-real-key",
}));

import { extractPurchaseInvoice } from "./anthropic";

const source = { kind: "pdf" as const, data: Buffer.from("isolated invoice fixture") };
const line = (fields: Record<string, unknown> = {}) => ({
  description: "Bebida de prueba", quantity: "2", unit: "und",
  unitPrice: "$42.417", lineTotal: "$138.850,00", taxPct: "5", confidence: 0.95,
  ...fields,
});
const invoice = (fields: Record<string, unknown> = {}) => ({
  documentType: "factura", supplierNit: null, supplierName: "Proveedor de prueba",
  supplierInvoiceNumber: "TEST-001", issueDate: "2026-10-16", currency: "COP",
  lines: [line()], invoiceSubtotal: null, invoiceTax: null, invoiceTotal: null,
  invoiceInc: null, retefuente: null, reteIva: null, reteIca: null, confidence: 0.95,
  ...fields,
});
async function extract(fields: Record<string, unknown> = {}) {
  mock.create.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(invoice(fields)) }] });
  return extractPurchaseInvoice(source);
}
beforeEach(() => mock.create.mockReset());

describe("purchase invoice extraction preserves printed tax meaning", () => {
  it("keeps the net unit, gross final, line consumption and document discount from the reported layout", async () => {
    const result = await extract({
      lines: [line({
        unitPriceTaxBasis: "net", unitPriceLabel: "P. UNIT ANTES IMPTO",
        lineTotalTaxBasis: "gross", lineTotalLabel: "VLR NETO FINAL",
        lineTax: null, lineInc: "$49.774", lineIncAmountKind: "line",
      })],
      invoiceSubtotal: "$1.123.901", invoiceDiscount: "$109.143",
      invoiceTax: "$67.245", invoiceInc: "$337.722", invoiceTotal: "$1.419.725",
      invoiceIncComponents: [{ label: "ADV", amount: "$240.557" }, { label: "ICL", amount: "$97.165" }],
    });
    expect(result.lines[0]).toMatchObject({
      quantity: 2, unitPriceCents: 4_241_700, lineTotalCents: 13_885_000,
      unitPriceTaxBasis: "net", unitPriceLabel: "P. UNIT ANTES IMPTO",
      lineTotalTaxBasis: "gross", lineTotalLabel: "VLR NETO FINAL",
      lineTaxCents: null, lineIncCents: 4_977_400, lineIncAmbiguous: false,
    });
    expect(result).toMatchObject({
      invoiceSubtotalCents: 112_390_100, invoiceDiscountCents: 10_914_300,
      invoiceTaxCents: 6_724_500, invoiceIncCents: 33_772_200, invoiceTotalCents: 141_972_500,
    });
  });

  it.each([
    ["2,5", "$1.234,56", "$3.086,40", "$617,28", "$40,05"],
    ["2.5", "$1,234.56", "$3,086.40", "$617.28", "$40.05"],
  ])("parses quantity %s and CO/US money without applying taxes twice", async (quantity, unitPrice, lineTotal, lineTax, lineInc) => {
    const result = await extract({ lines: [line({ quantity, unitPrice, lineTotal, lineTax, lineInc,
      unitPriceTaxBasis: "gross", lineTotalTaxBasis: "gross", lineIncAmountKind: "line" })] });
    expect(result.lines[0]).toMatchObject({ quantity: 2.5, unitPriceCents: 123_456,
      lineTotalCents: 308_640, lineTaxCents: 61_728, lineIncCents: 4_005 });
  });

  it("retains independent unit/total bases instead of deriving one from the other", async () => {
    const result = await extract({ lines: [line({ unitPrice: "119", lineTotal: "200",
      unitPriceTaxBasis: "gross", lineTotalTaxBasis: "net", taxPct: "19" })] });
    expect(result.lines[0]).toMatchObject({ unitPriceCents: 11_900, lineTotalCents: 20_000,
      unitPriceTaxBasis: "gross", lineTotalTaxBasis: "net" });
  });

  it.each([
    ["unit", 2, 2_110], ["unit", 2.5, 2_638], ["line", 2, 1_055],
  ])("normalizes consumption marked %s for quantity %s exactly once", async (lineIncAmountKind, quantity, expected) => {
    const result = await extract({ lines: [line({ quantity, lineInc: "10,55", lineIncAmountKind })] });
    expect(result.lines[0]).toMatchObject({ lineIncCents: expected, lineIncAmbiguous: false });
  });

  it.each(["unknown", undefined, "invalid"])("flags a printed consumption amount with %s kind for review", async (lineIncAmountKind) => {
    const result = await extract({ lines: [line({ lineInc: "49.774", lineIncAmountKind })] });
    expect(result.lines[0]).toMatchObject({ lineIncCents: null, lineIncAmbiguous: true });
  });

  it("does not silently discard unreadable consumption", async () => {
    const result = await extract({ lines: [line({ lineInc: "ilegible", lineIncAmountKind: "line" })] });
    expect(result.lines[0]).toMatchObject({ lineIncCents: null, lineIncAmbiguous: true });
  });

  it("keeps malformed non-null consumption visible as a review issue", async () => {
    const result = await extract({ lines: [line({ lineInc: {}, lineIncAmountKind: "line" })] });
    expect(result.lines[0]).toMatchObject({ lineIncCents: null, lineIncAmbiguous: true });
  });

  it("recognizes zero consumption without guessing whether it is per-unit or per-line", async () => {
    const result = await extract({ lines: [line({ lineInc: "$0", lineIncAmountKind: "unknown" })] });
    expect(result.lines[0]).toMatchObject({ lineIncCents: 0, lineIncAmbiguous: false });
  });

  it("keeps legacy amounts unchanged and defaults absent metadata to unknown", async () => {
    const result = await extract();
    expect(result.lines[0]).toMatchObject({
      unitPriceCents: 4_241_700, lineTotalCents: 13_885_000,
      unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown",
      lineTaxCents: null, lineIncCents: null, lineIncAmbiguous: false,
    });
    expect(result.invoiceDiscountCents).toBeNull();
  });

  it("does not let invalid metadata invent a tax basis", async () => {
    const result = await extract({ lines: [line({ unitPriceTaxBasis: null,
      lineTotalTaxBasis: "tax-free", unitPriceLabel: {}, lineTotalLabel: false })] });
    expect(result.lines[0]).toMatchObject({ unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown",
      unitPriceLabel: null, lineTotalLabel: null });
  });

  it("uses printed document IVA without adding the printed line IVA again", async () => {
    const result = await extract({ invoiceTax: "19,00", lines: [line({ lineTax: "19,00" })] });
    expect(result.invoiceTaxCents).toBe(1_900);
    expect(result.lines[0].lineTaxCents).toBe(1_900);
  });
});

describe("document consumption totals", () => {
  it("sums distinct ADV/ICL components in code only when no combined total is printed", async () => {
    const result = await extract({ invoiceIncComponents: [
      { label: "ADV", amount: "$240.557" }, { label: "ICL", amount: "$97.165" },
      { label: "Ad Valorem (ADV)", amount: "$240.557" },
      { label: "IVA 5%", amount: "$44.842" }, { label: "IVA 19%", amount: "$22.403" },
      { label: "RETEICA", amount: "100" },
    ] });
    expect(result.invoiceIncCents).toBe(33_772_200);
    expect(result.invoiceTaxCents).toBeNull();
  });

  it("does not add ADV/ICL to a combined consumption total repeated among the components", async () => {
    const result = await extract({ invoiceIncComponents: [
      { label: "ADV", amount: "240.557" }, { label: "ICL", amount: "97.165" },
      { label: "Impuesto al consumo", amount: "337.722" },
    ] });
    expect(result.invoiceIncCents).toBe(33_772_200);
  });

  it("respects an explicitly printed zero total over components", async () => {
    const result = await extract({ invoiceInc: "0", invoiceIncComponents: [{ label: "ICL", amount: "900" }] });
    expect(result.invoiceIncCents).toBe(0);
  });

  it("does not replace an unreadable combined total with a calculated subtotal", async () => {
    const result = await extract({ invoiceInc: "ilegible", invoiceIncComponents: [{ label: "ICL", amount: "900" }] });
    expect(result.invoiceIncCents).toBeNull();
  });

  it.each([
    [{ label: "ADV", amount: "100" }, { label: "ADV", amount: "200" }],
    [{ label: "ADV", amount: "100" }, { label: "ICL", amount: "ilegible" }],
  ])("does not invent a combined total from conflicting or unreadable components", async (...invoiceIncComponents) => {
    const result = await extract({ invoiceIncComponents });
    expect(result.invoiceIncCents).toBeNull();
  });

  it("keeps absent consumption nullable", async () => {
    expect((await extract()).invoiceIncCents).toBeNull();
  });
});

describe("nullable monetary parsing and extraction instructions", () => {
  it.each([null, "", "no legible", {}, false, "-1", "5 %", 1e20])("keeps unusable amount %j nullable instead of failing the whole extraction", async value => {
    const result = await extract({ invoiceDiscount: value,
      lines: [line({ lineTax: value, unitPrice: value, lineTotal: "100" })] });
    expect(result.lines[0]).toMatchObject({ unitPriceCents: null, lineTotalCents: 10_000, lineTaxCents: null });
    expect(result.invoiceDiscountCents).toBeNull();
  });

  it("returns empty nullable totals for malformed model responses", async () => {
    mock.create.mockResolvedValue({ content: [{ type: "text", text: "not json" }] });
    expect(await extractPurchaseInvoice(source)).toMatchObject({
      lines: [], confidence: 0, invoiceDiscountCents: null, invoiceIncCents: null,
    });
    mock.create.mockResolvedValue({ content: [{ type: "text", text: '{"lines":false}' }] });
    expect(await extractPurchaseInvoice(source)).toMatchObject({
      lines: [], confidence: 0, invoiceDiscountCents: null, invoiceIncCents: null,
    });
  });

  it("discards non-product quantities without inventing units", async () => {
    const result = await extract({ lines: [line({ quantity: "0" }), line({ quantity: "ilegible" }), line({ quantity: "1" })] });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].quantity).toBe(1);
  });

  it("asks for net/gross evidence separately and never assumes discriminated IVA means net totals", async () => {
    await extract();
    const request = mock.create.mock.calls[0][0];
    const prompt = request.system[0].text as string;
    for (const field of ["unitPriceTaxBasis", "lineTotalTaxBasis", "unitPriceLabel", "lineTotalLabel",
      "lineTax", "lineInc", "lineIncAmountKind", "invoiceDiscount", "invoiceIncComponents"]) {
      expect(prompt).toContain(`"${field}"`);
    }
    expect(prompt).toContain("VLR NETO FINAL");
    expect(prompt).toContain("ADV");
    expect(prompt).toContain("ICL");
    expect(prompt).not.toContain("unitPrice/lineTotal son el NETO");
    expect(request.messages[0].content[0].source.data).toBe(source.data.toString("base64"));
  });
});
