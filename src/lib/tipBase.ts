// Base de la propina de una cuenta — LÓGICA PURA, sin DB.
//
// Arma el `TipBase` (lo cobrable y su parte sin impuesto) que consumen
// todas las superficies de la propina (`tips.ts`). Vive aparte de
// `tips.ts` porque depende del reparto de la factura electrónica
// (`dian/discountedLines.ts`, que trae dependencias de servidor): lo
// calcula el servidor y a las pantallas del navegador les llega el número.
//
// El reparto es EXACTAMENTE el de la factura (`saleLines`): cada línea con
// su tarifa (los platos con el impuesto del comercio embebido, las líneas
// libres con el suyo sumado encima), el descuento del cliente repartido en
// las líneas, las cancelaciones y los ítems en $0 fuera. La base sin
// impuesto es Σ de las bases netas de las líneas — la misma suma que
// declara el XML —, así que la propina sugerida y la factura no pueden
// discrepar en qué es «el valor antes de impuestos».

import {
  saleLines,
  type OrderItemForInvoice,
  type SaleLines,
} from "@/lib/dian/discountedLines";
import type { RestaurantTax } from "@/lib/salesTax";
import { tipBasePolicyFor, type TipBase, type TipBasePolicy } from "@/lib/tips";

/** El `TipBase` de unas líneas ya repartidas (ver `saleLines`). */
export function tipBaseOfSale(
  sale: Pick<SaleLines, "lines">,
  policy: TipBasePolicy = tipBasePolicyFor(),
): TipBase {
  let preTaxCents = 0;
  let chargeableCents = 0;
  for (const line of sale.lines) {
    preTaxCents += line.lineTotalCents;
    chargeableCents += line.lineTotalCents + line.taxCents;
  }
  return {
    chargeableCents,
    preTaxCents: policy === "with_tax" ? chargeableCents : preTaxCents,
  };
}

/**
 * El `TipBase` de los ítems VIVOS de una cuenta con la tarifa del comercio
 * y el descuento del cliente. El caller filtra lo cancelado (ítem o ronda)
 * como lo hace para el subtotal; `saleLines` igual descarta lo que tenga
 * `cancelledAt`, cantidad o precio en cero.
 */
export function tipBaseOfItems(
  items: readonly OrderItemForInvoice[],
  restaurantTax: RestaurantTax,
  discountCents = 0,
  policy: TipBasePolicy = tipBasePolicyFor(),
): TipBase {
  return tipBaseOfSale(saleLines(items, restaurantTax, discountCents), policy);
}
