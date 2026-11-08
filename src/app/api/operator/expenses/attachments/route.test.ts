import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseInvoiceExtraction } from "@/lib/anthropic";
import { InvoiceExtractionError } from "@/lib/erp/invoiceExtractionError";

const m = vi.hoisted(() => ({
  extract: vi.fn(),
  context: vi.fn(),
  suppliers: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  env: { ANTHROPIC_API_KEY: "isolated-test-key" as string | undefined },
}));

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/anthropic", () => ({ extractPurchaseInvoice: m.extract }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: m.context,
  isDenied: (context: { error?: string }) => Boolean(context.error),
}));
vi.mock("@/lib/db", () => ({ db: { supplier: { findMany: m.suppliers } } }));
vi.mock("@/lib/env", () => ({ env: m.env }));
vi.mock("fs/promises", () => ({ mkdir: m.mkdir, readFile: m.readFile, writeFile: m.writeFile }));

import { POST } from "./route";

const storedDirectory = "/private/tmp/isolated-expense-attachments-test";
const storedFileUrl = "/uploads/gasto-0123456789abcdef.pdf";
const contents = Buffer.from("isolated expense document");

const chargeAccount = (overrides: Partial<PurchaseInvoiceExtraction> = {}): PurchaseInvoiceExtraction => ({
  documentType: "cuenta_de_cobro",
  supplierNit: "900123456",
  supplierName: "Proveedor de prueba",
  supplierInvoiceNumber: "CC-TEST-1",
  issueDate: "2026-11-08",
  currency: "COP",
  lines: [],
  invoiceSubtotalCents: 850_000,
  invoiceDiscountCents: null,
  invoiceTaxCents: null,
  invoiceTotalCents: 850_000,
  invoiceIncCents: null,
  retefuenteCents: null,
  reteIvaCents: null,
  reteIcaCents: null,
  confidence: 0.9,
  notes: "",
  ...overrides,
});

function uploadForm(read = true) {
  const body = new FormData();
  body.append("file", new File([contents], "expense.pdf", { type: "application/pdf" }));
  if (read) body.append("read", "1");
  return body;
}

function rereadForm(fileUrl = storedFileUrl) {
  const body = new FormData();
  body.append("fileUrl", fileUrl);
  body.append("read", "1");
  return body;
}

const post = (body: FormData) => POST(new Request("http://localhost/api/operator/expenses/attachments", {
  method: "POST", body,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("UPLOAD_DIR", storedDirectory);
  m.env.ANTHROPIC_API_KEY = "isolated-test-key";
  m.context.mockResolvedValue({ restaurantId: "restaurant-test", country: "CO" });
  m.mkdir.mockResolvedValue(undefined);
  m.readFile.mockResolvedValue(contents);
  m.writeFile.mockResolvedValue(undefined);
  m.suppliers.mockResolvedValue([{ id: "supplier-test", taxId: "900.123.456-7" }]);
  m.extract.mockResolvedValue(chargeAccount());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("expense attachment extraction failures", () => {
  it.each(["ai_response_incomplete", "ai_invalid_response", "ai_timeout"] as const)(
    "retains the new attachment after %s without prefill or supplier searches",
    async (code) => {
      m.extract.mockRejectedValue(Object.assign(new InvoiceExtractionError(code), {
        providerResponse: "private supplier document text",
      }));

      const response = await post(uploadForm());
      const result = await response.json();

      expect(response.status).toBe(201);
      expect(result).toEqual({ fileUrl: expect.stringMatching(/^\/uploads\/gasto-[a-f0-9]{16}\.pdf$/), aiError: "ai_failed" });
      expect(m.writeFile).toHaveBeenCalledWith(`${storedDirectory}/${result.fileUrl.split("/").pop()}`, contents);
      expect(m.extract).toHaveBeenCalledTimes(1);
      expect(m.suppliers).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith("expense_attachment_ai_failed", { code });
    },
  );

  it("does not expose an unexpected provider error in the response or logs", async () => {
    m.extract.mockRejectedValue(new Error("provider token and private invoice amount"));

    const response = await post(uploadForm());
    const result = await response.json();

    expect(result).toEqual({ fileUrl: expect.any(String), aiError: "ai_failed" });
    expect(m.suppliers).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("expense_attachment_ai_failed", { code: "ai_failed" });
  });

  it("keeps the same existing attachment when rereading fails", async () => {
    m.extract.mockRejectedValue(new InvoiceExtractionError("ai_response_incomplete"));

    const response = await post(rereadForm());

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ fileUrl: storedFileUrl, aiError: "ai_failed" });
    expect(m.readFile).toHaveBeenCalledWith(`${storedDirectory}/gasto-0123456789abcdef.pdf`);
    expect(m.writeFile).not.toHaveBeenCalled();
    expect(m.suppliers).not.toHaveBeenCalled();
  });
});

describe("expense attachment prefill compatibility", () => {
  it("checks accounting access before storing or reading a document", async () => {
    m.context.mockResolvedValue({ error: "module_disabled", status: 403 });
    const response = await post(uploadForm());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "module_disabled" });
    expect(m.writeFile).not.toHaveBeenCalled();
    expect(m.extract).not.toHaveBeenCalled();
  });

  it("rejects an empty document before storing it or invoking AI", async () => {
    const body = new FormData();
    body.append("file", new File([], "empty.pdf", { type: "application/pdf" }));
    body.append("read", "1");
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_size" });
    expect(m.writeFile).not.toHaveBeenCalled();
    expect(m.extract).not.toHaveBeenCalled();
  });

  it("preserves a valid charge account's printed totals even when it has no product lines", async () => {
    const response = await post(uploadForm());
    const result = await response.json();

    expect(response.status).toBe(201);
    expect(result.prefill).toEqual({
      documentType: "charge_account",
      documentNumber: "CC-TEST-1",
      documentDate: "2026-11-08",
      supplierName: "Proveedor de prueba",
      supplierTaxId: "900123456",
      supplierId: "supplier-test",
      subtotalCents: 850_000,
      discountCents: null,
      ivaPct: null,
      ivaCents: null,
      incCents: null,
      totalCents: 850_000,
      confidence: 0.9,
    });
    expect(result).not.toHaveProperty("aiError");
    expect(m.extract).toHaveBeenCalledWith({ kind: "pdf", data: contents });
    expect(m.suppliers).toHaveBeenCalledWith({
      where: { restaurantId: "restaurant-test", taxId: { not: null } },
      select: { id: true, taxId: true },
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    ["pdf", { kind: "pdf" }],
    ["jpg", { kind: "image", mimeType: "image/jpeg" }],
  ])("rereads the stored %s without uploading another copy", async (extension, source) => {
    const fileUrl = `/uploads/gasto-0123456789abcdef.${extension}`;
    const response = await post(rereadForm(fileUrl));
    const result = await response.json();

    expect(result.fileUrl).toBe(fileUrl);
    expect(result.prefill).toMatchObject({ documentType: "charge_account", totalCents: 850_000 });
    expect(m.extract).toHaveBeenCalledWith({ ...source, data: contents });
    expect(m.readFile).toHaveBeenCalledWith(`${storedDirectory}/gasto-0123456789abcdef.${extension}`);
    expect(m.writeFile).not.toHaveBeenCalled();
    expect(m.mkdir).not.toHaveBeenCalled();
  });

  it("still allows attaching a document without requesting AI", async () => {
    const response = await post(uploadForm(false));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ fileUrl: expect.any(String) });
    expect(m.extract).not.toHaveBeenCalled();
    expect(m.suppliers).not.toHaveBeenCalled();
  });

  it("preserves the attachment when AI is not configured", async () => {
    m.env.ANTHROPIC_API_KEY = undefined;
    const response = await post(uploadForm());
    expect(await response.json()).toEqual({ fileUrl: expect.any(String), aiError: "ai_unavailable" });
    expect(m.extract).not.toHaveBeenCalled();
  });

  it("does not prefill an unrelated document", async () => {
    m.extract.mockResolvedValue(chargeAccount({ documentType: "otro", confidence: 0 }));
    const response = await post(uploadForm());
    expect(await response.json()).toEqual({ fileUrl: expect.any(String), aiError: "not_a_document" });
    expect(m.suppliers).not.toHaveBeenCalled();
  });

  it("does not read an arbitrary existing file path", async () => {
    const response = await post(rereadForm("/uploads/../private.pdf"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "no_file" });
    expect(m.readFile).not.toHaveBeenCalled();
    expect(m.extract).not.toHaveBeenCalled();
  });

  it("returns not found if the stored attachment is missing", async () => {
    m.readFile.mockRejectedValue(new Error("ENOENT"));
    const response = await post(rereadForm());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no_file" });
    expect(m.extract).not.toHaveBeenCalled();
  });
});
