// Libro diario y libro mayor traducen el origen con `opErp.jSource_<source>`.
// Faltaba `manual`, así que los comprobantes manuales salían como el texto
// crudo «manual». Cada origen que escribe MESAPAY tiene que tener su clave
// en los tres idiomas.
import { describe, expect, it } from "vitest";
import es from "../../../../messages/es.json";
import en from "../../../../messages/en.json";
import pt from "../../../../messages/pt.json";
import { makeSourceLabel } from "./labels";

/** Orígenes de `JournalEntry.source` que crea el producto. */
const SOURCES = [
  "sale",
  "customer_credit_payment",
  "purchase",
  "purchase_payment",
  "cogs",
  "waste",
  "expense",
  "expense_payment",
  "depreciation",
  "deferred",
  "payroll",
  "refund",
  "credit_note",
  "manual",
  "bank",
  "taxpay",
  "closing",
  "deferred_item",
];

describe("etiquetas de origen del asiento", () => {
  for (const [locale, messages] of [["es", es], ["en", en], ["pt", pt]] as const) {
    it(`${locale}: todo origen tiene su jSource_ en opErp`, () => {
      const opErp = messages.opErp as Record<string, string>;
      const missing = SOURCES.filter((s) => typeof opErp[`jSource_${s}`] !== "string");
      expect(missing).toEqual([]);
    });
  }

  it("el comprobante manual ya no sale como «manual» crudo", () => {
    const opErp = es.opErp as Record<string, string>;
    const t = Object.assign((k: string) => opErp[k]!, { has: (k: string) => k in opErp });
    expect(makeSourceLabel(t)("manual")).toBe("Comprobante manual");
    expect(makeSourceLabel(t)("origen_nuevo")).toBe("origen_nuevo");
  });
});
