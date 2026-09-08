// Impuesto de venta a nivel de LÍNEA — lógica pura, sin DB.
//
// Dos regímenes conviven en la misma cuenta:
//
//   Platos del menú → el impuesto va EMBEBIDO en el precio. Un plato de
//   $30.000 se cobra $30.000 y el impoconsumo sale por dentro. La tarifa es
//   la del comercio (salesTaxKind / salesTaxPct).
//
//   Líneas libres (servicios, bonos, cargos sueltos) → el impuesto se SUMA
//   ENCIMA, que es como se cotiza un servicio: "$2.400.000 + IVA". Cada
//   línea trae su propio tipo y tarifa, porque un restaurante en INC 8%
//   puede tener que facturar un servicio con IVA 19%.
//
// Sin esto el impuesto era uno solo para todo el comercio y no había forma
// de facturar un servicio con un impuesto distinto al de la carta.

import { embeddedTaxCents } from "@/lib/erp/accounting";

export type SalesTaxKind = "none" | "inc" | "iva";

export type TaxedLine = {
  /** Precio unitario snapshot × cantidad ya aplicada por el caller. */
  amountCents: number;
  /** null ⇒ plato del menú: impuesto embebido con la tarifa del comercio. */
  taxKind: string | null;
  taxPct: number | null;
};

export type RestaurantTax = { kind: SalesTaxKind; pct: number };

/** ¿La línea lleva su propio impuesto sumado encima? */
export function isOwnTaxLine(l: TaxedLine): boolean {
  return l.taxKind != null;
}

/** Impuesto que se SUMA al precio de una línea libre. 0 para las del menú. */
export function lineTaxOnTopCents(l: TaxedLine): number {
  if (!isOwnTaxLine(l)) return 0;
  const pct = l.taxPct ?? 0;
  if (l.taxKind === "none" || pct <= 0 || l.amountCents <= 0) return 0;
  return Math.round((l.amountCents * pct) / 100);
}

/**
 * Impuesto que ya viene DENTRO del precio de una línea. Las del menú usan la
 * tarifa del comercio; las libres no tienen nada embebido (su impuesto va
 * encima, no adentro).
 */
export function lineTaxEmbeddedCents(l: TaxedLine, r: RestaurantTax): number {
  if (isOwnTaxLine(l)) return 0;
  if (r.kind === "none") return 0;
  return embeddedTaxCents(l.amountCents, r.pct);
}

export type OrderTaxTotals = {
  /** Σ de los precios de las líneas (las libres, sin su impuesto). */
  subtotalCents: number;
  /** Σ del impuesto que se suma encima. Entra al total a cobrar. */
  taxOnTopCents: number;
  /** Lo que hay que cobrar por comida: subtotal + impuesto sumado. */
  chargeableCents: number;
  /** Impuesto causado, por tipo — para el reporte fiscal. */
  byKind: { inc: number; iva: number };
};

/**
 * Totales de impuesto de una orden. `subtotalCents` NO incluye el impuesto
 * de las líneas libres: ese se suma aparte, y por eso el total a cobrar deja
 * de ser sólo el subtotal.
 *
 * `byKind` suma lo embebido y lo sumado encima bajo el mismo tipo, que es lo
 * que el reporte fiscal necesita: antes todo caía en INC o en IVA según el
 * único tipo del comercio, y con líneas mixtas eso queda mal.
 */
export function orderTaxTotals(
  lines: TaxedLine[],
  r: RestaurantTax,
): OrderTaxTotals {
  let subtotalCents = 0;
  let taxOnTopCents = 0;
  const byKind = { inc: 0, iva: 0 };

  for (const l of lines) {
    subtotalCents += l.amountCents;
    const onTop = lineTaxOnTopCents(l);
    taxOnTopCents += onTop;
    const kind = (isOwnTaxLine(l) ? l.taxKind : r.kind) as SalesTaxKind;
    const amount = onTop + lineTaxEmbeddedCents(l, r);
    if (kind === "inc") byKind.inc += amount;
    else if (kind === "iva") byKind.iva += amount;
  }

  return {
    subtotalCents,
    taxOnTopCents,
    chargeableCents: subtotalCents + taxOnTopCents,
    byKind,
  };
}
