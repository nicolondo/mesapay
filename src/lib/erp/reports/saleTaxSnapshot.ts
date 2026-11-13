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
import { saleLines } from "@/lib/dian/discountedLines";
import { lineDeclaresTax, type DianLine } from "@/lib/dian/ubl";

export type SaleSnapshotTax = { kind: "none" | "inc" | "iva"; pct: number; baseCents: number; taxCents: number };

export function saleTaxOfSnapshot(
  snap: Pick<InvoiceSnapshot, "salesTaxKind" | "salesTaxPct" | "embeddedTaxCents" | "embeddedBaseCents" | "subtotalCents">,
): SaleSnapshotTax {
  const frozen = frozenSalesTax(snap);
  const taxCents = frozen.kind === "none" ? 0 : (snap.embeddedTaxCents ?? 0);
  const baseCents = snap.embeddedBaseCents != null ? snap.embeddedBaseCents : snap.subtotalCents - taxCents;
  return { kind: frozen.kind, pct: frozen.pct, baseCents, taxCents };
}

/** Lo que una factura vieja declaró de más por no llevar el descuento del cliente en sus líneas. */
export type UndeclaredDiscount = {
  /** Descuento que se le dio al cliente y que la factura no declaró. */
  discountCents: number;
  /** Valor de las líneas (LineExtensionAmount) declarado de más. */
  valueCents: number;
  /** Base gravable (TaxExclusiveAmount) declarada de más. */
  baseCents: number;
  /** INC + IVA declarados de más. */
  taxCents: number;
};

/**
 * Factura con descuento del cliente emitida ANTES de que el descuento fuera
 * dentro de las líneas (`InvoiceSnapshot.discountInLines` ausente): su XML
 * declaró el precio de lista. Devuelve cuánto valor, base e impuesto
 * declaró de más, recalculando las líneas con el MISMO reparto que hoy
 * (`saleLines`) desde los ítems y la tarifa que congeló el snapshot, sin y
 * con el descuento. null si la factura no tiene descuento o ya lo declara.
 *
 * No reescribe nada: esas facturas ya las aceptó la DIAN y su historia no
 * cambia. Es lo que lista la revisión «descuentoSinDeclarar».
 */
export function undeclaredDiscountOf(
  snap: Pick<InvoiceSnapshot, "items" | "discountCents" | "discountInLines" | "salesTaxKind" | "salesTaxPct">,
): UndeclaredDiscount | null {
  const discount = snap.discountCents ?? 0;
  if (discount <= 0 || snap.discountInLines) return null;
  const items = (snap.items ?? []).map((i) => ({
    nameSnapshot: i.name,
    qty: i.qty,
    priceCentsSnapshot: i.priceCents,
    cancelledAt: null,
    taxKind: i.taxKind ?? null,
    taxPct: i.taxPct ?? null,
  }));
  const tax = frozenSalesTax(snap);
  const listed = saleLines(items, tax, 0).lines;
  const net = saleLines(items, tax, discount);
  const value = (ls: readonly DianLine[]) => ls.reduce((s, l) => s + l.lineTotalCents, 0);
  const base = (ls: readonly DianLine[]) => ls.filter(lineDeclaresTax).reduce((s, l) => s + l.lineTotalCents, 0);
  const taxOf = (ls: readonly DianLine[]) => ls.reduce((s, l) => s + l.taxCents, 0);
  if (net.discountCents <= 0) return null;
  return {
    discountCents: net.discountCents,
    valueCents: value(listed) - value(net.lines),
    baseCents: base(listed) - base(net.lines),
    taxCents: taxOf(listed) - taxOf(net.lines),
  };
}
