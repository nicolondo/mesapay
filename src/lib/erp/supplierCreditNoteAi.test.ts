import { describe, expect, it } from "vitest";
import type { PurchaseInvoiceExtraction } from "@/lib/anthropic";
import { creditNotePrefillFromInvoice, guessCreditNoteKind } from "./supplierCreditNoteAi";

const base: PurchaseInvoiceExtraction = {
  documentType: "nota_credito",
  cude: "abc123",
  referencedInvoiceNumbers: ["FE-100"],
  creditNoteConcept: "Bonificación por volumen octubre",
  supplierNit: "900123456",
  supplierName: "Cervecería del Valle",
  supplierInvoiceNumber: "NC-77",
  issueDate: "2026-11-05",
  currency: "COP",
  lines: [],
  invoiceSubtotalCents: null,
  invoiceTaxCents: null,
  invoiceTotalCents: 250_000_00,
  invoiceIncCents: null,
  retefuenteCents: null,
  reteIvaCents: null,
  reteIcaCents: null,
  confidence: 0.9,
  notes: "",
};

describe("lectura con IA de una nota crédito", () => {
  it("prellena número, fecha, CUDE, valor, facturas citadas y sugiere el tipo", () => {
    const p = creditNotePrefillFromInvoice(base);
    expect(p).toMatchObject({
      isCreditNote: true,
      number: "NC-77",
      date: "2026-11-05",
      cude: "abc123",
      totalCents: 250_000_00,
      ivaCents: null,
      kind: "agreement",
      referencedInvoiceNumbers: ["FE-100"],
      concept: "Bonificación por volumen octubre",
    });
  });

  it("con IVA impreso infiere la tarifa; sin IVA no lo inventa", () => {
    const p = creditNotePrefillFromInvoice({ ...base, invoiceTotalCents: 119_000, invoiceTaxCents: 19_000, creditNoteConcept: "Descuento comercial" });
    expect(p).toMatchObject({ ivaCents: 19_000, ivaPct: 19, kind: "discount" });
  });

  it("avisa cuando el documento no es una nota crédito", () => {
    expect(creditNotePrefillFromInvoice({ ...base, documentType: "factura" }).isCreditNote).toBe(false);
  });

  it("tipo por el concepto", () => {
    expect(guessCreditNoteKind("Devolución de mercancía")).toBe("return");
    expect(guessCreditNoteKind("Descuento por pronto pago")).toBe("conditional_discount");
    expect(guessCreditNoteKind("Rappel cumplimiento de meta")).toBe("agreement");
    expect(guessCreditNoteKind("Ajuste de precio")).toBe("discount");
    expect(guessCreditNoteKind("")).toBeNull();
  });
});
