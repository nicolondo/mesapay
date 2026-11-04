// «Leer con IA» del soporte de un gasto: sólo se traduce la extracción del
// lector de facturas de compra a los campos del gasto (nunca se llama a la
// IA en las pruebas).
import { describe, expect, it } from "vitest";
import type { PurchaseInvoiceExtraction } from "@/lib/anthropic";
import { expensePrefillFromInvoice, inferIvaPct } from "./expenseAi";

const extraction = (over: Partial<PurchaseInvoiceExtraction> = {}): PurchaseInvoiceExtraction => ({
  documentType: "factura",
  supplierNit: "900123456-7",
  supplierName: " Refrigeración Andina SAS ",
  supplierInvoiceNumber: "FE-901",
  issueDate: "2026-10-08",
  currency: "COP",
  lines: [],
  invoiceSubtotalCents: 1_000_000,
  invoiceDiscountCents: null,
  invoiceTaxCents: 190_000,
  invoiceTotalCents: 1_190_000,
  invoiceIncCents: null,
  retefuenteCents: 25_000,
  reteIvaCents: null,
  reteIcaCents: null,
  confidence: 0.9,
  notes: "",
  ...over,
});

describe("expensePrefillFromInvoice", () => {
  it("factura con IVA 19 %: documento, proveedor, subtotal, IVA impreso y tarifa", () => {
    expect(expensePrefillFromInvoice(extraction())).toEqual({
      documentType: "e_invoice",
      documentNumber: "FE-901",
      documentDate: "2026-10-08",
      supplierName: "Refrigeración Andina SAS",
      supplierTaxId: "900123456-7",
      subtotalCents: 1_000_000,
      discountCents: null,
      ivaPct: 19,
      ivaCents: 190_000,
      incCents: null,
      totalCents: 1_190_000,
      confidence: 0.9,
    });
  });

  it("cuenta de cobro sin subtotal: subtotal = total − IVA − INC", () => {
    const p = expensePrefillFromInvoice(
      extraction({ documentType: "cuenta_de_cobro", invoiceSubtotalCents: null, invoiceTaxCents: null, invoiceTotalCents: 800_000 }),
    );
    expect(p).toMatchObject({ documentType: "charge_account", subtotalCents: 800_000, ivaPct: null, ivaCents: null });
  });

  it("descuento: se conserva si el subtotal es antes del descuento; se descarta si ya venía neto", () => {
    const gross = expensePrefillFromInvoice(
      extraction({ invoiceSubtotalCents: 1_000_000, invoiceDiscountCents: 100_000, invoiceTaxCents: 171_000, invoiceTotalCents: 1_071_000 }),
    );
    expect(gross).toMatchObject({ subtotalCents: 1_000_000, discountCents: 100_000, ivaPct: 19 });
    const net = expensePrefillFromInvoice(
      extraction({ invoiceSubtotalCents: 900_000, invoiceDiscountCents: 100_000, invoiceTaxCents: 171_000, invoiceTotalCents: 1_071_000 }),
    );
    expect(net).toMatchObject({ subtotalCents: 900_000, discountCents: null });
  });

  it("las retenciones impresas no se copian (las practica el comercio con sus conceptos)", () => {
    expect(Object.keys(expensePrefillFromInvoice(extraction()))).not.toContain("retefuenteCents");
  });

  it("un documento que no es de compra no sugiere tipo; una fecha rara se ignora", () => {
    expect(expensePrefillFromInvoice(extraction({ documentType: "otro", issueDate: "8/10/26" }))).toMatchObject({
      documentType: null,
      documentDate: null,
    });
  });
});

describe("inferIvaPct", () => {
  it("la tarifa del país más cercana (±0,6 puntos), o null", () => {
    expect(inferIvaPct(1_000_000, 190_000)).toBe(19);
    expect(inferIvaPct(1_000_000, 50_400)).toBe(5);
    expect(inferIvaPct(1_000_000, 0)).toBe(0);
    expect(inferIvaPct(1_000_000, 120_000)).toBeNull();
    expect(inferIvaPct(1_000_000, 160_000, "MX")).toBe(16);
  });
});
