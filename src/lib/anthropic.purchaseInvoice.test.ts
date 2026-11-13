import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn(), env: { ANTHROPIC_MODEL: "claude-haiku-4-5" } }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = {
    create: mock.create,
    stream: (...args: unknown[]) => {
      mock.stream(...args);
      return { finalMessage: () => mock.create(...args) };
    },
  }; },
}));
vi.mock("./env", () => ({
  env: mock.env,
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
  mock.create.mockResolvedValue(reply(JSON.stringify(invoice(fields))));
  return extractPurchaseInvoice(source);
}
function reply(text: string, stop_reason = "end_turn") {
  return { content: [{ type: "text", text }], stop_reason, usage: { output_tokens: 500 } };
}
beforeEach(() => { mock.create.mockReset(); mock.stream.mockReset(); mock.env.ANTHROPIC_MODEL = "claude-haiku-4-5"; });

describe("purchase invoice response recovery", () => {
  it("accepts complete fenced JSON without changing amounts or retrying", async () => {
    mock.create.mockResolvedValue(reply(`\uFEFF\n\`\`\`json\n${JSON.stringify(invoice())}\n\`\`\``));
    const result = await extractPurchaseInvoice(source);
    expect(result.lines[0]).toMatchObject({ quantity: 2, lineTotalCents: 13_885_000 });
    expect(mock.create).toHaveBeenCalledTimes(1);
    expect(mock.stream).toHaveBeenCalledTimes(1);
  });

  it("rereads a truncated response from the original document with a larger bounded budget", async () => {
    mock.create.mockResolvedValueOnce(reply('```json {"documentType":"factura","lines":[', "max_tokens"))
      .mockResolvedValueOnce(reply(JSON.stringify(invoice({ invoiceTotal: "138.850,00" }))));
    const result = await extractPurchaseInvoice(source);
    expect(result.lines).toHaveLength(1);
    expect(result.invoiceTotalCents).toBe(13_885_000);
    expect(mock.stream).toHaveBeenCalledTimes(2);
    const [first, second] = mock.create.mock.calls;
    expect(first[0].max_tokens).toBeGreaterThan(8192);
    expect(second[0].max_tokens).toBeGreaterThan(first[0].max_tokens);
    expect(second[0].max_tokens).toBeLessThanOrEqual(64_000);
    expect(second[0].messages).toHaveLength(1);
    expect(second[0].messages[0].content[0]).toEqual(first[0].messages[0].content[0]);
    expect(second[1].maxRetries).toBe(0);
    expect(second[1].signal).toBe(first[1].signal);
  });

  it("rejects even parseable JSON when the provider reports truncation", async () => {
    mock.create.mockResolvedValue(reply(JSON.stringify(invoice()), "max_tokens"));
    await expect(extractPurchaseInvoice(source)).rejects.toMatchObject({ code: "ai_response_incomplete" });
    expect(mock.create).toHaveBeenCalledTimes(2);
  });

  it.each(["not JSON", '{"lines":false}', JSON.stringify(invoice({ lines: [line({ description: null })] }))])(
    "retries an invalid response once, then fails without returning an empty invoice: %s", async text => {
      mock.create.mockResolvedValue(reply(text));
      await expect(extractPurchaseInvoice(source)).rejects.toMatchObject({ code: "ai_invalid_response", message: "ai_invalid_response" });
      expect(mock.create).toHaveBeenCalledTimes(2);
    },
  );

  it("recovers malformed JSON with one complete fresh reading", async () => {
    mock.create.mockResolvedValueOnce(reply('{"supplierName":"private supplier",'))
      .mockResolvedValueOnce(reply(JSON.stringify(invoice())));
    expect((await extractPurchaseInvoice(source)).lines).toHaveLength(1);
    expect(mock.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry a provider refusal or expose its response", async () => {
    mock.create.mockResolvedValue(reply("private document details", "refusal"));
    await expect(extractPurchaseInvoice(source)).rejects.toMatchObject({ code: "ai_invalid_response", message: "ai_invalid_response" });
    expect(mock.create).toHaveBeenCalledTimes(1);
  });

  it("keeps one deadline across both reads and does not retry request failures", async () => {
    const error = Object.assign(new Error("provider timeout"), { name: "APIConnectionTimeoutError" });
    mock.create.mockRejectedValue(error);
    await expect(extractPurchaseInvoice(source)).rejects.toMatchObject({ code: "ai_timeout" });
    expect(mock.create).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled stream at the shared deadline and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      mock.create.mockImplementation((_params, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      const result = expect(extractPurchaseInvoice(source)).rejects.toMatchObject({ code: "ai_timeout" });
      await vi.advanceTimersByTimeAsync(480_000);
      await result;
      expect(mock.create).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not reset the deadline when rereading an invalid response", async () => {
    vi.useFakeTimers();
    try {
      mock.create.mockImplementationOnce(() => new Promise(resolve => {
        setTimeout(() => resolve(reply("invalid")), 300_000);
      })).mockImplementationOnce((_params, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      const result = expect(extractPurchaseInvoice(source)).rejects.toMatchObject({ code: "ai_timeout" });
      await vi.advanceTimersByTimeAsync(480_000);
      await result;
      expect(mock.create).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("preserves every line of a complete long invoice", async () => {
    const lines = Array.from({ length: 100 }, (_, index) => line({ description: `Producto ${index + 1}` }));
    const result = await extract({ lines });
    expect(result.lines).toHaveLength(100);
    expect(result.lines[99]).toMatchObject({ description: "Producto 100", quantity: 2, lineTotalCents: 13_885_000 });
    expect(mock.create).toHaveBeenCalledTimes(1);
  });

  it("keeps a valid document with no product lines available to the expense reader", async () => {
    expect((await extract({ lines: [], invoiceTotal: "50.000" })).invoiceTotalCents).toBe(5_000_000);
  });

  it("does not increase the requested output limit for an unrecognized custom model", async () => {
    mock.env.ANTHROPIC_MODEL = "custom-invoice-model";
    mock.create.mockResolvedValueOnce(reply("{", "max_tokens"))
      .mockResolvedValueOnce(reply(JSON.stringify(invoice())));
    expect((await extractPurchaseInvoice(source)).lines).toHaveLength(1);
    expect(mock.create.mock.calls.map(([params]) => params.max_tokens)).toEqual([8192, 8192]);
    expect(mock.create.mock.calls.map(([params]) => params.model)).toEqual(["custom-invoice-model", "custom-invoice-model"]);
  });
});

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
    // A discount is a subtraction by definition: suppliers print it as
    // "-$1" or "$1" and both mean the same positive discount.
    expect(result.invoiceDiscountCents).toBe(value === "-1" ? 100 : null);
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
      "lineTax", "lineInc", "taxColumns", "columnHeaders", "invoiceAdjustment", "invoiceDiscount", "invoiceIncComponents"]) {
      expect(prompt).toContain(`"${field}"`);
    }
    expect(prompt).toContain("VLR NETO FINAL");
    expect(prompt).toContain("ADV");
    expect(prompt).toContain("ICL");
    expect(prompt).not.toContain("unitPrice/lineTotal son el NETO");
    expect(request.messages[0].content[0].source.data).toBe(source.data.toString("base64"));
  });
});


describe("deterministic purchase invoice tax detection", () => {
  it("detects a footer-only supplier with IVA included without trusting a missing model classification", async () => {
    const result = await extract({ lines: [
      line({ quantity: "1", unitPrice: null, lineTotal: "119,00", taxPct: "19" }),
      line({ quantity: "4", unitPrice: null, lineTotal: "210,00", taxPct: "5" }),
    ], invoiceSubtotal: "300,00", invoiceTax: "29,00", invoiceTotal: "329,00" });
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["gross", "gross"]);
    expect(result.lines.map(l => l.lineTotalCents)).toEqual([11_900, 21_000]);
    expect(result.invoiceTaxCents).toBe(2_900);
  });

  it("detects a supplier whose line totals exclude IVA", async () => {
    const result = await extract({ lines: [
      line({ quantity: "1", unitPrice: null, lineTotal: "100,00", taxPct: "19" }),
      line({ quantity: "4", unitPrice: null, lineTotal: "200,00", taxPct: "5" }),
    ], invoiceSubtotal: "300,00", invoiceTax: "29,00", invoiceTotal: "329,00" });
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["net", "net"]);
  });

  it("detects each line independently when a document mixes final and base columns", async () => {
    const result = await extract({ lines: [
      line({ unitPrice: null, lineTotal: "238,00", lineTax: "38,00", taxPct: "19" }),
      line({ unitPrice: null, lineTotal: "200,00", lineTotalLabel: "Antes de IVA", taxPct: "5" }),
    ] });
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["gross", "net"]);
  });

  it("does not generalize generic final/net column titles across suppliers", async () => {
    const result = await extract({ lines: [line({ unitPrice: "119,50", lineTotal: "239,00",
      unitPriceLabel: "P. FINAL UNIT", lineTotalLabel: "VLR NETO FINAL" })] });
    expect(result.lines[0]).toMatchObject({ unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown" });
    const prompt = mock.create.mock.calls[0][0].system[0].text as string;
    expect(prompt).not.toContain('Si solo existe un unitario final, transcríbelo y marca unitPriceTaxBasis="gross"');
    expect(prompt).not.toContain('son "gross" aunque usen la palabra NETO');
  });

  it("persists contradictory evidence across schema parsing and repeated normalization", async () => {
    const result = await extract({ lines: [line({ unitPrice: null, lineTotal: "238,00",
      lineTotalTaxBasis: "net", lineTotalLabel: "IVA incluido", taxPct: "19" })] });
    expect(result.lines[0]).toMatchObject({ lineTotalTaxBasis: "unknown", lineTotalTaxBasisConflict: true });
    const { PurchaseInvoiceSchema } = await import("./anthropic");
    const { inferPurchaseInvoiceTaxBases } = await import("./erp/invoiceTaxBasis");
    expect(inferPurchaseInvoiceTaxBases(PurchaseInvoiceSchema.parse(result)).lines[0])
      .toMatchObject({ lineTotalTaxBasis: "unknown", lineTotalTaxBasisConflict: true });
  });
});

describe("supplier discounts are transcribed, never applied by the extractor", () => {
  it("keeps the printed list price, line % and line value as positive amounts", async () => {
    const result = await extract({ lines: [line({
      quantity: "2", unitPrice: "$9.000", unitPriceLabel: "P. UNIT ANTES IMPTO", lineTotal: "$18.000",
      listUnitPrice: "$10.000", lineDiscountPct: "10 %", lineDiscount: "-$2.000", taxPct: "19",
    })], invoiceDiscount: "-$2.000" });
    expect(result.lines[0]).toMatchObject({
      unitPriceCents: 900_000, lineTotalCents: 1_800_000,
      listUnitPriceCents: 1_000_000, lineDiscountPct: 10, lineDiscountCents: 200_000,
    });
    expect(result.invoiceDiscountCents).toBe(200_000);
  });

  it.each([
    ["12,5", 12.5], ["12.5%", 12.5], ["-5%", 5], ["0", null], ["150", null], ["n/a", null],
  ])("reads the printed discount %s as %s", async (lineDiscountPct, expected) => {
    const result = await extract({ lines: [line({ lineDiscountPct })] });
    expect(result.lines[0]?.lineDiscountPct).toBe(expected);
  });

  it("keeps responses without discount fields (older prompt) valid with null discounts", async () => {
    const result = await extract();
    expect(result.lines[0]).toMatchObject({ listUnitPriceCents: null, lineDiscountPct: null, lineDiscountCents: null });
    const { PurchaseInvoiceSchema } = await import("./anthropic");
    const legacy = { ...result, lines: result.lines.map((l) => {
      const { listUnitPriceCents: _list, lineDiscountPct: _pct, lineDiscountCents: _value, ...rest } = l;
      void _list; void _pct; void _value;
      return rest;
    }) };
    expect(PurchaseInvoiceSchema.safeParse(legacy).success).toBe(true);
  });

  it("asks only for transcription of discounts and excludes conditional prompt-payment discounts", async () => {
    await extract();
    const prompt = mock.create.mock.calls[0][0].system[0].text as string;
    expect(prompt).toContain("listUnitPrice");
    expect(prompt).toContain("lineDiscountPct");
    expect(prompt).toContain("NO calcules ni restes");
    expect(prompt).toContain("pronto pago");
  });
});

// Respuesta simulada del modelo para una factura SINTÉTICA con la estructura
// de un distribuidor de licores (columnas Cant. | Vlr. Unitario | IVA % |
// IVA (Unitario) | ICO | Vlr. Total; pie Subtotal, Descuentos, IVA, ICO,
// − Retefuente, Ajustes, Total). Proveedor, productos y montos inventados.
// El ICO es por unidad aunque su encabezado no lo diga.
const LIQUOR_LINES = [
  ["Ginebra de prueba 700ml", "3.00", "45,333.30", "2,266.67", "31,250.00", "135,999.90"],
  ["Ron de prueba 750ml", "2.00", "38,120.50", "1,906.03", "22,100.00", "76,241.00"],
  ["Vino de prueba 750ml", "6.00", "27,450.00", "1,372.50", "8,640.00", "164,700.00"],
  ["Aperitivo de prueba 1L", "1.00", "61,800.40", "3,090.02", "19,980.00", "61,800.40"],
] as const;
function liquorReading(consumoScope: string, fields: Record<string, unknown> = {}) {
  return invoice({
    supplierName: "Licores Sintéticos S.A.S.", supplierInvoiceNumber: "SIM 1",
    columnHeaders: ["Nro. Ítem", "Descripción Ítem", "UM", "Cant.", "Vlr. Unitario", "IVA %", "IVA (Unitario)", "ICO", "Vlr. Total"],
    taxColumns: [
      { tax: "iva", header: "IVA (Unitario)", scope: "unit", evidence: "El encabezado dice Unitario" },
      { tax: "consumo", header: "ICO", scope: consumoScope, evidence: "Columna de valor junto al total de la línea" },
    ],
    lines: LIQUOR_LINES.map(([description, quantity, unitPrice, lineTax, lineInc, lineTotal]) => ({
      description, quantity, unit: "UNID", unitPrice, lineTotal, taxPct: "5.00", lineTax, lineInc,
      unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown", unitPriceLabel: "Vlr. Unitario",
      lineTotalLabel: "Vlr. Total", listUnitPrice: null, lineDiscountPct: null, lineDiscount: null, confidence: 0.95,
    })),
    invoiceSubtotal: "438,741.30", invoiceDiscount: "0.00", invoiceTax: "21,937.07", invoiceInc: "209,770.00",
    retefuente: "-10,968.53", reteIva: null, reteIca: null, invoiceAdjustment: "0.16", invoiceTotal: "659,480.00",
    ...fields,
  });
}

describe("liquor invoice with a per-unit consumption tax (ICO)", () => {
  it("corrects an ICO the model read as line total because the footer proves it is per unit", async () => {
    mock.create.mockResolvedValue(reply(JSON.stringify(liquorReading("line"))));
    const result = await extractPurchaseInvoice(source);
    expect(result.lines.map(l => l.lineIncCents)).toEqual([9_375_000, 4_420_000, 5_184_000, 1_998_000]);
    expect(result.lines.reduce((sum, l) => sum + (l.lineIncCents ?? 0), 0)).toBe(result.invoiceIncCents);
    expect(result.lines.every(l => l.lineIncAmbiguous === false)).toBe(true);
    // IVA (Unitario) × cantidad: guardado como el IVA de cada línea, igual al pie al centavo.
    expect(result.lines.reduce((sum, l) => sum + (l.lineTaxCents ?? 0), 0)).toBe(2_193_707);
    expect(result.taxColumns?.consumo).toMatchObject({ status: "matched", scope: "unit", aiScope: "line", header: "ICO" });
    expect(result.taxColumns?.iva).toMatchObject({ status: "matched", scope: "unit" });
    expect(result.lines[0]).toMatchObject({ lineIncCell: { cents: 3_125_000, pct: null }, arithmeticDiffCents: null });
    expect(result).toMatchObject({ retefuenteCents: 1_096_853, invoiceAdjustmentCents: 16, invoiceTotalCents: 65_948_000 });
    // With consumption resolved, the totals prove each line total is before taxes.
    expect(result.lines.map(l => l.lineTotalTaxBasis)).toEqual(["net", "net", "net", "net"]);
  });

  it("also corrects an older-style reading that marked every line as line total", async () => {
    const reading = liquorReading("line", { taxColumns: undefined,
      lines: liquorReading("line").lines.map(l => ({ ...l, lineIncAmountKind: "line" })) });
    mock.create.mockResolvedValue(reply(JSON.stringify(reading)));
    const result = await extractPurchaseInvoice(source);
    expect(result.lines.map(l => l.lineIncCents)).toEqual([9_375_000, 4_420_000, 5_184_000, 1_998_000]);
    expect(result.taxColumns?.consumo).toMatchObject({ status: "matched", scope: "unit", aiScope: "line" });
  });

  it("reads a negative rounding adjustment printed with a unicode minus", async () => {
    mock.create.mockResolvedValue(reply(JSON.stringify(liquorReading("unit", { invoiceAdjustment: "−0,32" }))));
    expect((await extractPurchaseInvoice(source)).invoiceAdjustmentCents).toBe(-32);
  });

  it("reports a line whose quantity × unit does not add up", async () => {
    const reading = liquorReading("unit", {
      lines: liquorReading("unit").lines.map((l, index) => index === 1 ? { ...l, lineTotal: "86,241.00" } : l) });
    mock.create.mockResolvedValue(reply(JSON.stringify(reading)));
    const result = await extractPurchaseInvoice(source);
    expect(result.lines[1]?.arithmeticDiffCents).toBe(1_000_000);
  });
});
