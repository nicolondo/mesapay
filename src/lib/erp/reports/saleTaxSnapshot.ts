/**
 * Impuesto DOCUMENTAL de una factura de venta a partir de su snapshot
 * (lógica pura): la tarifa que congeló al emitirse (`frozenSalesTax`), el
 * impuesto embebido y la base, con la misma regla que `computeTaxSummary`
 * para los snapshots viejos sin base congelada (subtotal − impuesto).
 *
 * Es la ÚNICA definición: la usan `loadSaleTaxDocs` (el documental del
 * período) y la tendencia (`loadSaleTaxTrendDocs`, que lee sólo estos
 * campos del snapshot), así las dos cifras no pueden separarse.
 */
import { frozenSalesTax, type InvoiceSnapshot } from "@/lib/invoice";

export type SaleSnapshotTax = { kind: "none" | "inc" | "iva"; pct: number; baseCents: number; taxCents: number };

export function saleTaxOfSnapshot(
  snap: Pick<InvoiceSnapshot, "salesTaxKind" | "salesTaxPct" | "embeddedTaxCents" | "embeddedBaseCents" | "subtotalCents">,
): SaleSnapshotTax {
  const frozen = frozenSalesTax(snap);
  const taxCents = frozen.kind === "none" ? 0 : (snap.embeddedTaxCents ?? 0);
  const baseCents = snap.embeddedBaseCents != null ? snap.embeddedBaseCents : snap.subtotalCents - taxCents;
  return { kind: frozen.kind, pct: frozen.pct, baseCents, taxCents };
}
