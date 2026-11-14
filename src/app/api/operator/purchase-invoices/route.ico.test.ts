// POST /api/operator/purchase-invoices de punta a punta con el modelo
// SIMULADO (sin red): la respuesta es la que daría la IA para una factura
// sintética con la estructura de un distribuidor de licores — Cant. |
// Vlr. Unitario | IVA % | IVA (Unitario) | ICO | Vlr. Total — y el modelo se
// equivoca al decir que el ICO es el total de la línea. El pie demuestra que
// es por unidad: lo que se guarda para revisar ya viene corregido.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  modelCall: vi.fn(), create: vi.fn(), context: vi.fn(), loadMatch: vi.fn(),
  mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { stream: (...args: unknown[]) => ({ finalMessage: () => m.modelCall(...args) }) }; },
}));
vi.mock("@/lib/env", () => ({ env: { ANTHROPIC_MODEL: "claude-haiku-4-5" }, requireAnthropicKey: () => "not-a-real-key" }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "invoice-reader-test" } }) }));
vi.mock("@/lib/erp/access", () => ({ getErpContext: m.context, isDenied: (value: { error?: string }) => !!value.error }));
vi.mock("@/lib/erp/invoiceMatchContext", () => ({ loadInvoiceMatchContext: m.loadMatch }));
vi.mock("@/lib/db", () => ({ db: { purchaseInvoiceUpload: { create: m.create } } }));
vi.mock("fs/promises", () => ({ mkdir: m.mkdir, writeFile: m.writeFile, unlink: m.unlink }));
import { POST } from "./route";

const LINES = [
  ["Ginebra de prueba 700ml", "3.00", "45,333.30", "2,266.67", "31,250.00", "135,999.90"],
  ["Ron de prueba 750ml", "2.00", "38,120.50", "1,906.03", "22,100.00", "76,241.00"],
  ["Vino de prueba 750ml", "6.00", "27,450.00", "1,372.50", "8,640.00", "164,700.00"],
  ["Aperitivo de prueba 1L", "1.00", "61,800.40", "3,090.02", "19,980.00", "61,800.40"],
];
const modelReading = {
  documentType: "factura", supplierNit: "900000001", supplierName: "Licores Sintéticos S.A.S.",
  supplierInvoiceNumber: "SIM 7", issueDate: "2026-11-11", currency: "COP",
  columnHeaders: ["Nro. Ítem (Código)", "Descripción Ítem (Código)", "UM", "Cant.", "Vlr. Unitario", "IVA %", "IVA (Unitario)", "ICO", "Vlr. Total"],
  taxColumns: [
    { tax: "iva", header: "IVA (Unitario)", scope: "unit", evidence: "El encabezado dice Unitario" },
    { tax: "consumo", header: "ICO", scope: "line", evidence: "Valor de la línea junto al total" },
  ],
  lines: LINES.map(([description, quantity, unitPrice, lineTax, lineInc, lineTotal]) => ({
    description, quantity, unit: "UNID", unitPrice, lineTotal, unitPriceTaxBasis: "unknown", lineTotalTaxBasis: "unknown",
    unitPriceLabel: "Vlr. Unitario", lineTotalLabel: "Vlr. Total", lineTax, lineInc, listUnitPrice: null,
    lineDiscountPct: null, lineDiscount: null, taxPct: "5.00", confidence: 0.95,
  })),
  invoiceSubtotal: "438,741.30", invoiceDiscount: "0.00", invoiceTax: "21,937.07", invoiceInc: "209,770.00",
  invoiceIncComponents: [], retefuente: "10,968.53", reteIva: null, reteIca: null, invoiceAdjustment: "0.16",
  invoiceTotal: "659,480.00", confidence: 0.93, notes: "",
};

function post() {
  const form = new FormData();
  form.append("file", new File(["synthetic liquor invoice"], "factura.pdf", { type: "application/pdf" }));
  return POST(new Request("http://localhost/api/operator/purchase-invoices", { method: "POST", body: form }));
}

beforeEach(() => {
  vi.resetAllMocks();
  m.context.mockResolvedValue({ restaurantId: "restaurant-test", country: "CO" });
  m.loadMatch.mockResolvedValue({ suppliers: [], ingredients: [], priceList: [] });
  m.create.mockResolvedValue({ id: "upload-ico" });
  m.modelCall.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify(modelReading) }], stop_reason: "end_turn", usage: { output_tokens: 900 },
  });
});

describe("liquor invoice: ICO per unit although the model said line total", () => {
  it("saves a review where consumption, IVA and the rounding already add up to the printed footer", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const saved = m.create.mock.calls[0]![0].data.extraction;
    expect(saved.lines.map((l: { lineIncCents: number }) => l.lineIncCents)).toEqual([9_375_000, 4_420_000, 5_184_000, 1_998_000]);
    const sum = (key: "lineIncCents" | "lineTaxCents") =>
      saved.lines.reduce((total: number, l: Record<string, number>) => total + l[key], 0);
    expect(sum("lineIncCents")).toBe(saved.invoiceIncCents);
    expect(sum("lineTaxCents")).toBe(saved.invoiceTaxCents);
    expect(saved.taxColumns.consumo).toMatchObject({ header: "ICO", aiScope: "line", scope: "unit", status: "matched" });
    // Subtotal + IVA + ICO − retefuente + ajustes = Total, al centavo.
    const lineNet = saved.lines.reduce((total: number, l: { lineTotalCents: number }) => total + l.lineTotalCents, 0);
    expect(lineNet + sum("lineTaxCents") + sum("lineIncCents") - saved.retefuenteCents + saved.invoiceAdjustmentCents)
      .toBe(saved.invoiceTotalCents);
    const body = await response.json();
    expect(body.match.lines).toHaveLength(4);
    expect(body.extraction.lines[1]).toMatchObject({ lineIncCell: { cents: 2_210_000, pct: null }, lineIncCents: 4_420_000 });
  });
});
