// Impuesto embebido en lo que el comensal paga — LÓGICA PURA, sin DB.
//
// Los platos de la carta llevan el impuesto de ventas del comercio ADENTRO
// del precio: una hamburguesa de $30.000 se cobra $30.000 y el impoconsumo es
// un componente de ese precio, no se suma encima. Las pantallas del comensal
// (pagar y ver pedido) muestran ese componente como un renglón INFORMATIVO:
//
//   Incluye impoconsumo 8% · $3.178
//
// que no cambia ningún total. El cálculo vive acá, separado del componente,
// para poder testearlo por modo de pago (Todo / Partes iguales / Lo mío).
//
// Las líneas libres (servicios, bonos) NO entran acá: su impuesto se SUMA
// encima y ya vive en Order.taxCents (ver salesTax.ts).

import { embeddedTaxCents, type SalesTaxKind } from "@/lib/erp/accounting";

export type PayMode = "full" | "equal" | "mine";

/** Impuesto de ventas del comercio (Restaurant.salesTaxKind / salesTaxPct). */
export type CheckoutTax = { kind: SalesTaxKind; pct: number };

/**
 * `Restaurant.salesTaxKind` es un String suelto en el schema: cualquier
 * valor que no sea inc/iva se trata como "sin impuesto", nunca se inventa.
 */
export function asSalesTaxKind(kind: string | null | undefined): SalesTaxKind {
  return kind === "inc" || kind === "iva" ? kind : "none";
}

/**
 * Lo que el comensal paga de COMIDA según el modo elegido, siempre sobre lo
 * que FALTA de la cuenta y no sobre el subtotal original: si alguien ya pagó
 * (Apple Pay, efectivo, datáfono, "lo mío"…), el resto de la mesa se reparte
 * lo que queda. Usar el subtotal original cobraba de más justo lo ya
 * recaudado — Mesa 1 debía $71k y partes iguales × 2 quería cobrar $214k.
 *
 *   full  → todo lo pendiente.
 *   equal → lo pendiente entre N personas (mínimo 2).
 *   mine  → los platos de la persona, topados por lo pendiente: si ya pagó
 *           su parte en una vuelta anterior y quedó asignada, no se le
 *           cobra dos veces.
 *
 * Cinturón y tirantes: pase lo que pase con la aritmética de un modo, nunca
 * devuelve más que lo pendiente.
 */
export function payModeSubtotalCents(
  mode: PayMode,
  outstandingSubtotalCents: number,
  opts: { splitCount: number; mineCents: number },
): number {
  let amount: number;
  if (mode === "full") {
    amount = outstandingSubtotalCents;
  } else if (mode === "equal") {
    amount = Math.round(outstandingSubtotalCents / Math.max(2, opts.splitCount));
  } else {
    amount = Math.min(opts.mineCents, outstandingSubtotalCents);
  }
  return Math.min(amount, outstandingSubtotalCents);
}

export type CheckoutTaxLine = {
  kind: Exclude<SalesTaxKind, "none">;
  pct: number;
  /** Impuesto que ya viene DENTRO del monto. */
  taxCents: number;
  /** Base gravable = monto − impuesto. */
  baseCents: number;
};

/**
 * Renglón "Incluye impoconsumo 8% · $X" para un monto que YA incluye el
 * impuesto. Se aplica sobre lo que el comensal paga de comida en su modo —
 * nunca sobre la propina, que no lleva impuesto. null ⇒ no se pinta nada:
 * comercio sin impuesto, tarifa en cero o monto en cero.
 */
export function checkoutTaxLine(
  amountCents: number,
  tax: CheckoutTax | null | undefined,
): CheckoutTaxLine | null {
  if (!tax || tax.kind === "none" || !(tax.pct > 0) || amountCents <= 0) {
    return null;
  }
  const taxCents = embeddedTaxCents(amountCents, tax.pct);
  if (taxCents <= 0) return null;
  return {
    kind: tax.kind,
    pct: tax.pct,
    taxCents,
    baseCents: amountCents - taxCents,
  };
}
