// Impuesto de ventas por TRAMO (tarifa) a partir de los pedidos pagados —
// lógica PURA, sin DB. Es el único lugar donde se decide cuánto impuesto
// causó un pedido: lo comparten la tarjeta de impuestos y el PYG
// (`accountingData.computeSalesTaxSummary`) y el asiento «Ventas del día»
// (`posting.ts`), que agrupa estos mismos pedidos por día de negocio. Así
// Σ días == mes al centavo y el libro dice lo mismo que la tarjeta.
//
// Reglas (ver también `computeSalesTaxSummary`):
//   · Pedido FACTURADO: lo que su factura congeló en el snapshot (tarifa
//     vigente al emitirla e impuesto/base declarados). Nunca "tarifa de
//     hoy × ventas": prender el impuesto no toca lo emitido antes.
//   · Snapshot sin tarifa (anterior a congelarla) ⇒ tramo "none", cero.
//   · Pedido SIN factura: tarifa actual del comercio sobre su subtotal; el
//     impuesto embebido se redondea POR PEDIDO (no sobre la suma), para que
//     el total no dependa de cómo se agrupen los pedidos.
import { frozenSalesTax, type InvoiceSnapshot } from "@/lib/invoice";
import { embeddedTaxCents, type SalesTaxKind, type SalesTaxSlice } from "./accounting";

/** Lo que hace falta de un pedido pagado para ubicar su impuesto. */
export type SalesTaxOrder = {
  subtotalCents: number;
  /** Snapshot de su factura, o null si la venta no tiene factura. */
  invoiceSnapshot: InvoiceSnapshot | null;
};

/** Régimen actual del comercio (para las ventas sin factura). */
export type CurrentSalesTax = { kind: SalesTaxKind; pct: number };

/** Normaliza la configuración del comercio: "none" ⇒ 0 %. */
export function currentSalesTaxOf(tenant: {
  salesTaxKind?: string | null;
  salesTaxPct?: number | null;
} | null): CurrentSalesTax {
  const kind = (tenant?.salesTaxKind ?? "none") as SalesTaxKind;
  return { kind, pct: kind === "none" ? 0 : tenant?.salesTaxPct ?? 0 };
}

/** Tramo (tipo, %, bruto, impuesto) de UN pedido. */
export function orderSalesTaxSlice(order: SalesTaxOrder, current: CurrentSalesTax): SalesTaxSlice {
  const snap = order.invoiceSnapshot;
  if (snap) {
    const frozen = frozenSalesTax(snap);
    const taxCents = frozen.kind === "none" ? 0 : (snap.embeddedTaxCents ?? 0);
    // Bruto del tramo: los platos del menú (base + impuesto) cuando el
    // snapshot lo congeló; para los viejos, el subtotal entero, que es lo
    // que el cálculo anterior tomaba como bruto.
    const grossCents = snap.embeddedBaseCents != null ? snap.embeddedBaseCents + taxCents : snap.subtotalCents;
    return { kind: frozen.kind, pct: frozen.pct, grossCents, taxCents, baseCents: grossCents - taxCents };
  }
  const grossCents = Math.max(0, order.subtotalCents);
  const taxCents = current.kind === "none" ? 0 : embeddedTaxCents(grossCents, current.pct);
  return { kind: current.kind, pct: current.pct, grossCents, taxCents, baseCents: grossCents - taxCents };
}

/** Suma tramos por (tipo, %). Conserva los tramos "none" (sirven para el bruto). */
export function sumSalesTaxSlices(slices: readonly SalesTaxSlice[]): SalesTaxSlice[] {
  const byKey = new Map<string, SalesTaxSlice>();
  for (const s of slices) {
    const key = `${s.kind}:${s.pct}`;
    const acc = byKey.get(key) ?? { kind: s.kind, pct: s.pct, grossCents: 0, taxCents: 0, baseCents: 0 };
    acc.grossCents += s.grossCents;
    acc.taxCents += s.taxCents;
    acc.baseCents = acc.grossCents - acc.taxCents;
    byKey.set(key, acc);
  }
  return [...byKey.values()];
}

/** Tramos de un conjunto de pedidos, sumados por tarifa. */
export function salesTaxSlicesFor(
  orders: readonly SalesTaxOrder[],
  current: CurrentSalesTax,
): SalesTaxSlice[] {
  return sumSalesTaxSlices(orders.map((o) => orderSalesTaxSlice(o, current)));
}

/**
 * `byRate` como lo exponen la tarjeta y el asiento: sólo los tramos que
 * causaron impuesto, el que más causó primero.
 */
export function salesTaxByRate(slices: readonly SalesTaxSlice[]): SalesTaxSlice[] {
  return slices
    .filter((s) => s.kind !== "none" && s.taxCents > 0)
    .sort((a, b) => b.taxCents - a.taxCents);
}

/**
 * Etiqueta del período: el tramo que más causó o, sin impuesto causado, la
 * configuración actual (así "none" sigue significando "sin impuesto
 * configurado"). Las devoluciones sin nota usan este régimen.
 */
export function salesTaxLabel(
  byRate: readonly SalesTaxSlice[],
  current: CurrentSalesTax,
): CurrentSalesTax {
  const top = byRate[0];
  return top ? { kind: top.kind, pct: top.pct } : current;
}
