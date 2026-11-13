import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseInvoiceExtraction } from "@/lib/anthropic";
import { InvoiceExtractionError } from "@/lib/erp/invoiceExtractionError";

const m = vi.hoisted(() => ({
  extract: vi.fn(), create: vi.fn(), context: vi.fn(), loadMatch: vi.fn(),
  mkdir: vi.fn(), writeFile: vi.fn(), unlink: vi.fn(),
}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "invoice-reader-test" } }) }));
vi.mock("@/lib/erp/access", () => ({ getErpContext: m.context, isDenied: (value: { error?: string }) => !!value.error }));
vi.mock("@/lib/anthropic", () => ({ extractPurchaseInvoice: m.extract }));
vi.mock("@/lib/erp/invoiceMatchContext", () => ({ loadInvoiceMatchContext: m.loadMatch }));
vi.mock("@/lib/db", () => ({ db: { purchaseInvoiceUpload: { create: m.create } } }));
vi.mock("fs/promises", () => ({ mkdir: m.mkdir, writeFile: m.writeFile, unlink: m.unlink }));
import { POST } from "./route";

const valid: PurchaseInvoiceExtraction = {
  documentType: "factura", supplierNit: null, supplierName: "Proveedor sintético",
  supplierInvoiceNumber: "READ-1", issueDate: "2026-11-08", currency: "COP",
  lines: [{ description: "Bebida sintética", quantity: 2, unit: "un", unitPriceCents: 100_000,
    lineTotalCents: 238_000, unitPriceTaxBasis: "net", lineTotalTaxBasis: "gross",
    taxPct: "19", confidence: 0.9 }],
  invoiceSubtotalCents: 200_000, invoiceTaxCents: 38_000, invoiceTotalCents: 238_000,
  invoiceIncCents: null, retefuenteCents: null, reteIvaCents: null, reteIcaCents: null, confidence: 0.9,
};
function post(type = "application/pdf", data = "synthetic invoice") {
  const form = new FormData();
  form.append("file", new File([data], "private-original-name.pdf", { type }));
  return POST(new Request("http://localhost/api/operator/purchase-invoices", { method: "POST", body: form }));
}
beforeEach(() => {
  vi.resetAllMocks();
  m.context.mockResolvedValue({ restaurantId: "restaurant-test", country: "CO" });
  m.extract.mockResolvedValue(valid);
  m.loadMatch.mockResolvedValue({ suppliers: [], ingredients: [], priceList: [] });
  m.create.mockResolvedValue({ id: "upload-test" });
  m.unlink.mockResolvedValue(undefined);
});

describe("purchase invoice upload rejects unreadable extractions", () => {
  it.each([
    ["ai_response_incomplete", 502], ["ai_invalid_response", 502], ["ai_timeout", 504],
  ] as const)("returns safe %s without creating an upload or storing a file", async (code, status) => {
    m.extract.mockRejectedValue(new InvoiceExtractionError(code));
    const response = await post();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.writeFile).not.toHaveBeenCalled();
    expect(m.loadMatch).not.toHaveBeenCalled();
  });

  it.each([
    { ...valid, lines: [] },
    { ...valid, lines: [{ ...valid.lines[0], description: "  " }] },
    { ...valid, lines: [{ ...valid.lines[0], unitPriceCents: null, lineTotalCents: null }] },
  ])("rejects a reading without usable lines after normalization", async extraction => {
    m.extract.mockResolvedValue(extraction);
    const response = await post();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "no_lines" });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.writeFile).not.toHaveBeenCalled();
    expect(m.loadMatch).not.toHaveBeenCalled();
  });

  it("does not treat a document of another kind as a purchase", async () => {
    m.extract.mockResolvedValue({ ...valid, documentType: "otro", lines: [], confidence: 0 });
    const response = await post();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "not_a_document" });
    expect(m.create).not.toHaveBeenCalled();
    expect(m.writeFile).not.toHaveBeenCalled();
  });

  it("persists a complete review without changing amounts or creating a purchase order", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ uploadId: "upload-test", extraction: valid });
    expect(body.fileUrl).toMatch(/^\/uploads\/factura-[a-f0-9]{16}\.pdf$/);
    expect(m.extract).toHaveBeenCalledWith({ kind: "pdf", data: Buffer.from("synthetic invoice") });
    expect(m.loadMatch).toHaveBeenCalledWith("restaurant-test", ["Bebida sintética"]);
    expect(m.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      restaurantId: "restaurant-test", status: "pending", extraction: valid, createdById: "invoice-reader-test",
    }), select: { id: true } });
    expect(m.writeFile.mock.invocationCallOrder[0]).toBeGreaterThan(m.extract.mock.invocationCallOrder[0]);
  });

  it("passes images to the same guarded reader", async () => {
    expect((await post("image/png")).status).toBe(200);
    expect(m.extract).toHaveBeenCalledWith({ kind: "image", data: Buffer.from("synthetic invoice"), mimeType: "image/png" });
  });

  it("does not hide an unexpected provider failure or persist its file", async () => {
    m.extract.mockRejectedValue(new Error("provider failed"));
    await expect(post()).rejects.toThrow("provider failed");
    expect(m.create).not.toHaveBeenCalled();
    expect(m.writeFile).not.toHaveBeenCalled();
  });

  it("cleans up only its new file if saving the valid upload fails", async () => {
    m.create.mockRejectedValue(new Error("database unavailable"));
    await expect(post()).rejects.toThrow("database unavailable");
    expect(m.unlink).toHaveBeenCalledWith(m.writeFile.mock.calls[0][0]);
  });

  it("preserves the original error when attachment cleanup also fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      m.create.mockRejectedValue(new Error("database unavailable"));
      m.unlink.mockRejectedValue(new Error("cannot unlink private filename"));
      await expect(post()).rejects.toThrow("database unavailable");
      expect(logged).toHaveBeenCalledWith("purchase_invoice_attachment_cleanup_failed");
    } finally { logged.mockRestore(); }
  });

  it("does not invoke AI for a denied operator", async () => {
    m.context.mockResolvedValue({ error: "module_disabled", status: 403 });
    expect((await post()).status).toBe(403);
    expect(m.extract).not.toHaveBeenCalled();
    expect(m.writeFile).not.toHaveBeenCalled();
  });

  it.each([["text/plain", "invoice", "bad_format"], ["application/pdf", "", "bad_size"]])(
    "rejects an invalid upload before extraction", async (type, data, error) => {
      const response = await post(type, data);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
      expect(m.extract).not.toHaveBeenCalled();
    },
  );
});
