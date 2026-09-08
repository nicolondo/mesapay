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
import { purchaseTaxRates } from "@/lib/erp/purchaseTax";

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

// ————————————————————————————————————————————————————————————————
// Líneas libres: topes y tarifas ofrecibles
// ————————————————————————————————————————————————————————————————

/**
 * Techo duro de los totales de una orden. `Order.subtotalCents`, `taxCents` y
 * `totalCents` son `Int` de Postgres: pasarse no da un error de negocio, da un
 * 500 al escribir. Por eso se valida ANTES de crear la línea.
 */
export const MAX_ORDER_TOTAL_CENTS = 2_147_483_647;

/**
 * Tope del TOTAL de una línea libre (precio unitario × cantidad), en centavos:
 * $10.000.000.
 *
 * No se reusa `MAX_MENU_PRICE_CENTS` ($5.000.000) porque ese es el tope de UN
 * plato, y acá lo natural es cotizar el servicio entero en una línea
 * ("catering del evento: $8.400.000"). Tampoco se deja abierto hasta el techo
 * del `Int`: una cuenta suma varias líneas, y si UNA sola pudiera llegar a
 * $21.474.836 la segunda reventaría el total. Con $10.000.000 por línea caben
 * dos servicios grandes (catering + alquiler del salón) más los platos y
 * todavía sobra la mitad del rango; quien necesite más parte el cobro.
 */
export const MAX_FREE_LINE_TOTAL_CENTS = 1_000_000_000;

/** Cantidad máxima de una línea libre (asistentes, horas de alquiler…). */
export const MAX_FREE_LINE_QTY = 999;

/**
 * Tarifas que se le pueden ofrecer a una línea libre, según el tipo de
 * impuesto y el país del comercio.
 *
 * El IVA reusa la tabla de compras (CO 0/5/19, MX 0/8/16) para no mantener dos
 * listas del mismo impuesto que se desincronizan. El INC es distinto: en
 * Colombia el de restaurantes y servicios es 8% y punto — un selector con
 * varias tarifas sólo invitaría a facturar mal. Para no cobrar impuesto el
 * tipo correcto es "none", no un INC en 0.
 */
export function salesTaxRates(
  kind: SalesTaxKind,
  country: string | null | undefined,
): number[] {
  if (kind === "none") return [0];
  if (kind === "iva") return purchaseTaxRates(country);
  return country === "MX" ? purchaseTaxRates(country) : [8];
}

/** ¿`pct` es una tarifa válida para ese tipo de impuesto en ese país? */
export function isValidSalesTaxRate(
  kind: SalesTaxKind,
  pct: number,
  country: string | null | undefined,
): boolean {
  if (kind === "none") return pct === 0;
  return salesTaxRates(kind, country).includes(pct);
}
