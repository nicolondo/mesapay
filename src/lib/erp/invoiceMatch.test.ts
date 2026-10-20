import { describe, expect, it } from "vitest";
import type { PurchaseInvoiceExtraction, PurchaseInvoiceLineType } from "@/lib/anthropic";
import {
  fold,
  lineTotalCents,
  matchInvoice,
  normalizeExtraction,
  normalizeInvoiceAlias,
  type MatchContext,
} from "./invoiceMatch";

const supplier = { id: "supplier-1", name: "Distribuidora Central SAS", nit: "901.123.456-7" };
const guessed = { id: "ingredient-guess", name: "Gordons", measureKind: "count" as const };
const selected = { id: "ingredient-selected", name: "Ginebra de la casa 700 ml", measureKind: "volume" as const };
const presentation = {
  supplierId: supplier.id, ingredientId: selected.id, supplierItemId: "presentation-1",
  presentationLabel: "Botella 700 ml", contentQty: 700, lastPriceCents: 6_942_500,
};

function line(overrides: Partial<PurchaseInvoiceLineType> = {}): PurchaseInvoiceLineType {
  return {
    description: "GORDONS DRY 700ML", quantity: 2, unit: "und",
    unitPriceCents: 6_942_500, lineTotalCents: 13_885_000, taxPct: "5",
    confidence: 0.9, ...overrides,
  };
}

function invoice(overrides: Partial<PurchaseInvoiceExtraction> = {}): PurchaseInvoiceExtraction {
  return {
    documentType: "factura", supplierNit: "9011234567", supplierName: supplier.name,
    supplierInvoiceNumber: "TEST-1", issueDate: "2026-10-20", currency: "COP",
    lines: [line()], invoiceSubtotalCents: null, invoiceTaxCents: null,
    invoiceTotalCents: 13_885_000, invoiceIncCents: null,
    retefuenteCents: null, reteIvaCents: null, reteIcaCents: null,
    confidence: 0.9, ...overrides,
  };
}

function context(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    suppliers: [supplier], ingredients: [guessed, selected], priceList: [presentation],
    aliases: [{ supplierId: supplier.id, ingredientId: selected.id, normalizedDescription: "gordons dry 700ml" }],
    ...overrides,
  };
}

describe("exact supplier invoice aliases", () => {
  it("normalizes accents, case, compatibility characters and whitespace without erasing numeric punctuation", () => {
    expect(normalizeInvoiceAlias("  CAFÉ\t Ａ  700ML ")).toBe("cafe a 700ml");
    expect(normalizeInvoiceAlias("Ron 1/2 L")).not.toBe(normalizeInvoiceAlias("Ron 1.2 L"));
    expect(normalizeInvoiceAlias("Ron 1,2 L")).not.toBe(normalizeInvoiceAlias("Ron 1.2 L"));
    expect(normalizeInvoiceAlias("Código AB-12")).not.toBe(normalizeInvoiceAlias("Código AB12"));
  });

  it("prioritizes a remembered exact description over a heuristic name and preserves monetary evidence", () => {
    const extracted = invoice();
    const result = matchInvoice(extracted, context());
    expect(result.supplier).toEqual({ kind: "matched", supplier });
    expect(result.lines[0]).toMatchObject({
      sourceLineIndex: 0, matchSource: "alias",
      ingredient: { kind: "matched", ingredient: selected }, suggestedPresentation: presentation,
    });
    expect(result.lines[0].line).toBe(extracted.lines[0]);
    expect(result.computedTotalCents).toBe(13_885_000);
  });

  it("uses a unique exact supplier name when no NIT was extracted", () => {
    const result = matchInvoice(invoice({ supplierNit: null, supplierName: " DISTRIBUIDORA CÉNTRAL SAS " }), context());
    expect(result.lines[0].matchSource).toBe("alias");
  });

  it("never carries an alias across suppliers", () => {
    const second = { id: "supplier-2", name: "Otro proveedor", nit: "123" };
    const result = matchInvoice(invoice({ supplierNit: "123", supplierName: second.name }), context({ suppliers: [supplier, second] }));
    expect(result.lines[0]).toMatchObject({
      matchSource: "name", ingredient: { kind: "matched", ingredient: guessed }, suggestedPresentation: null,
    });
  });

  it.each([
    { supplierNit: null, supplierName: "Distribuidora Central" },
    { supplierNit: "999999999", supplierName: supplier.name },
  ])("does not learn or apply aliases from fuzzy or contradictory supplier evidence: %j", (evidence) => {
    const result = matchInvoice(invoice(evidence), context());
    expect(result.lines[0].matchSource).toBe("name");
    expect(result.lines[0].ingredient).toEqual({ kind: "matched", ingredient: guessed });
  });

  it("does not apply an alias when the NIT identifies multiple suppliers", () => {
    const result = matchInvoice(invoice(), context({
      suppliers: [supplier, { ...supplier, id: "duplicate", name: "Otro registro" }],
    }));
    expect(result.lines[0].matchSource).not.toBe("alias");
  });

  it("does not apply an alias when normalized exact supplier names are ambiguous", () => {
    const result = matchInvoice(invoice({ supplierNit: null }), context({
      suppliers: [supplier, { ...supplier, id: "duplicate", name: "distribuidora céntral sas" }],
    }));
    expect(result.lines[0].matchSource).not.toBe("alias");
  });

  it("honors a validated explicit supplier selection even when OCR has another name", () => {
    const result = matchInvoice(invoice({ supplierNit: null, supplierName: "OCR desconocido" }), context(), supplier.id);
    expect(result.supplier).toEqual({ kind: "matched", supplier });
    expect(result.lines[0].matchSource).toBe("alias");
  });

  it("does not accept an explicit supplier missing from the scoped context", () => {
    const result = matchInvoice(invoice(), context(), "foreign");
    expect(result.supplier.kind).toBe("suggest_create");
    expect(result.lines[0].matchSource).not.toBe("alias");
  });

  it("does not fuzzy-match the alias description or collapse distinct numeric quantities", () => {
    const result = matchInvoice(invoice({ lines: [line({ description: "GORDONS DRY 1.2 L" })] }), context({
      aliases: [{ supplierId: supplier.id, ingredientId: selected.id, normalizedDescription: "gordons dry 1/2 l" }],
    }));
    expect(result.lines[0].matchSource).toBe("name");
  });

  it.each([null, "archived-or-foreign-id"])("suppresses heuristic fallback for an unusable saved ingredient: %s", (ingredientId) => {
    const result = matchInvoice(invoice(), context({
      aliases: [{ supplierId: supplier.id, ingredientId, normalizedDescription: "gordons dry 700ml" }],
    }));
    expect(result.lines[0]).toMatchObject({
      aliasUnavailable: true, ingredient: { kind: "suggest_create", name: "GORDONS DRY 700ML" },
      suggestedPresentation: null,
    });
    expect(result.lines[0].matchSource).toBeUndefined();
  });

  it("indexes the persisted extraction without dropping or reordering its lines", () => {
    const extracted = invoice({ lines: [line({ description: "Original primera" }), line(), line({ description: "Última" })] });
    const result = matchInvoice(extracted, context());
    expect(result.lines.map((entry) => entry.sourceLineIndex)).toEqual([0, 1, 2]);
    expect(result.lines[1].matchSource).toBe("alias");
  });

  it("keeps old matching contexts compatible without aliases", () => {
    const result = matchInvoice(invoice(), { suppliers: [supplier], ingredients: [guessed], priceList: [] });
    expect(result.lines[0]).toMatchObject({ matchSource: "name", ingredient: { kind: "matched", ingredient: guessed } });
  });
});

describe("invoice matching compatibility", () => {
  it("suggests new suppliers and ingredients while flagging low confidence", () => {
    const result = matchInvoice(invoice({ supplierName: null, supplierNit: null, lines: [line({ confidence: 0.4 })] }), context({ suppliers: [], ingredients: [] }));
    expect(result.supplier).toEqual({ kind: "suggest_create", name: "", nit: null });
    expect(result.lines[0]).toMatchObject({ lowConfidence: true, ingredient: { kind: "suggest_create", name: "GORDONS DRY 700ML" } });
  });

  it("matches reordered meaningful name tokens but does not match empty or tiny tokens", () => {
    const ingredients = [{ ...selected, name: "Aceite Oliva" }];
    expect(matchInvoice(invoice({ lines: [line({ description: "Oliva virgen Aceite" })] }), context({ ingredients, aliases: [] })).lines[0].matchSource).toBe("name");
    for (const description of ["", "a 1", "Pan blanco"]) {
      expect(matchInvoice(invoice({ lines: [line({ description })] }), context({ ingredients, aliases: [] })).lines[0].ingredient.kind).toBe("suggest_create");
    }
    expect(fold("Crème  BRÛLÉE!")).toBe("creme brulee");
  });

  it("normalizes only before persistence, discarding unusable extracted lines", () => {
    const raw = invoice({ lines: [
      line({ description: "  Leche " }), line({ description: " " }),
      line({ quantity: 0 }), line({ unitPriceCents: null, lineTotalCents: null }),
    ] });
    expect(normalizeExtraction(raw).lines).toEqual([line({ description: "Leche" })]);
    expect(raw.lines).toHaveLength(4);
  });

  it("uses explicit totals including zero and falls back to quantity times unit price", () => {
    expect(lineTotalCents(line({ lineTotalCents: 0 }))).toBe(0);
    expect(lineTotalCents(line({ lineTotalCents: null, quantity: 1.5, unitPriceCents: 101 }))).toBe(152);
    expect(lineTotalCents(line({ lineTotalCents: null, unitPriceCents: null }))).toBe(0);
  });
});
