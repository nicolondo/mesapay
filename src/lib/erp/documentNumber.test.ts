import { describe, expect, it } from "vitest";
import { normalizeDocumentNumber, parseDuplicateConflict } from "./documentNumber";

describe("normalizeDocumentNumber", () => {
  it.each([
    ["FE-000123", "FE123"],
    ["fe 123", "FE123"],
    ["FE0123", "FE123"],
    ["FE123", "FE123"],
    ["  FE - 123  ", "FE123"],
    ["FE.123", "FE123"],
    ["FE/123", "FE123"],
    ["000123", "123"],
    ["123", "123"],
    ["SETP990000001", "SETP990000001"],
    ["Factura N° FE-12", "FE12"],
    ["Factura de venta electrónica FE-0012", "FE12"],
    ["No. 0045", "45"],
    ["Nº 45", "45"],
    ["Nro 45", "45"],
    ["Número 45", "45"],
    ["#45", "45"],
    ["A-0", "A0"],
    ["0000", "0"],
    ["Fé-1", "FE1"],
  ])("%j → %j", (raw, key) => {
    expect(normalizeDocumentNumber(raw)).toBe(key);
  });

  it("treats the same invoice written differently as one key", () => {
    const variants = ["FE-000123", "fe 123", "FE0123", "Factura No. FE 123", "FE–123".replace("–", "-")];
    expect(new Set(variants.map(normalizeDocumentNumber))).toEqual(new Set(["FE123"]));
  });

  it("keeps different invoices apart", () => {
    expect(normalizeDocumentNumber("FE-123")).not.toBe(normalizeDocumentNumber("FE-124"));
    expect(normalizeDocumentNumber("FE-123")).not.toBe(normalizeDocumentNumber("FV-123"));
    // Un prefijo «N»/«NO» sin punto ni símbolo es parte del número.
    expect(normalizeDocumentNumber("N123")).toBe("N123");
    expect(normalizeDocumentNumber("NO123")).toBe("NO123");
  });

  it.each([null, undefined, "", "   ", " - . / "])("no number: %j", (raw) => {
    expect(normalizeDocumentNumber(raw)).toBeNull();
  });
});

describe("parseDuplicateConflict", () => {
  const existing = {
    kind: "purchase",
    id: "po-1",
    number: "FE-1",
    purchaseNumber: 7,
    date: "2026-11-01T17:00:00.000Z",
    totalCents: 1_000_000,
    supplierName: "Distribuidora",
    href: "/operator/compras?oc=po-1",
  };

  it("reads the 409 body of a blocked duplicate", () => {
    expect(parseDuplicateConflict({ error: "duplicate_document", duplicate: existing })).toEqual({
      code: "duplicate_document",
      existing,
    });
  });

  it("reads a possible duplicate (no invoice number)", () => {
    expect(parseDuplicateConflict({ error: "possible_duplicate", duplicate: { ...existing, number: null } })?.code).toBe(
      "possible_duplicate",
    );
  });

  it.each([
    null,
    "x",
    { error: "invalid" },
    { error: "duplicate_document" },
    { error: "duplicate_document", duplicate: { ...existing, kind: "other" } },
    { error: "duplicate_document", duplicate: { ...existing, href: 1 } },
  ])("ignores anything else: %j", (body) => {
    expect(parseDuplicateConflict(body)).toBeNull();
  });
});
