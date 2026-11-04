// Impuesto de una línea de compra MANUAL («Nueva orden» y «Recibir
// mercancía») — LÓGICA PURA, sin BD. La importan el formulario (cálculo en
// vivo) y el servidor (recepción).
//
// Un solo control «Impuesto» por línea: sin impuesto, IVA a una tarifa del
// país, impuesto al consumo, o los dos cuando la factura los trae. Es la
// misma convención de la revisión de facturas con IA (purchaseTax.ts):
//  · el IVA es una TARIFA sobre el neto (taxPct) y sigue al costo real;
//  · el consumo (INC) es un IMPORTE aparte, nunca IVA, y es costo: entra al
//    inventario (o al gasto si el insumo no lleva inventario). Lo que se
//    guarda es el valor total de la línea (`expectedIncCents`); en la
//    pantalla se escribe como % de la base de la línea (8 % lo típico) o
//    como valor fijo. En una recepción por partes se reparte por cantidad.
import type { DiscountInput } from "./purchaseDiscount";
import {
  normalizeTaxPct,
  proportionalCents,
  purchaseLineAmounts,
  receivedPurchaseLineAmounts,
  type PurchaseLineAmountsInput,
} from "./purchaseTax";

/** Tope de un monto de la compra en centavos (cabe en INT4). */
export const PURCHASE_MAX_CENTS = 2_000_000_000;

/** % de consumo que se propone al elegir «Impuesto al consumo». */
export const DEFAULT_INC_PCT = 8;

/** Lo que dice el control «Impuesto» de la línea. */
export type LineTaxChoice = {
  /** Tarifa de IVA (0 = sin IVA). */
  ivaPct: number;
  /** ¿La línea lleva impuesto al consumo? */
  inc: boolean;
};

/**
 * Opciones del control, en orden: sin impuesto, cada tarifa de IVA del país,
 * impuesto al consumo y cada tarifa de IVA + consumo. `current` agrega una
 * tarifa guardada que ya no está en la lista del país (fila vieja) para no
 * perderla en el select.
 */
export function lineTaxOptions(rates: readonly number[], current?: LineTaxChoice): LineTaxChoice[] {
  const positive = [...new Set([...rates, ...(current && current.ivaPct > 0 ? [current.ivaPct] : [])])]
    .filter((r) => r > 0)
    .sort((a, b) => a - b);
  return [
    { ivaPct: 0, inc: false },
    ...positive.map((ivaPct) => ({ ivaPct, inc: false })),
    { ivaPct: 0, inc: true },
    ...positive.map((ivaPct) => ({ ivaPct, inc: true })),
  ];
}

/** Valor del `<option>` ("iva:19", "inc", "iva:19+inc", "none"). */
export function encodeLineTax(c: LineTaxChoice): string {
  if (c.ivaPct > 0) return c.inc ? `iva:${c.ivaPct}+inc` : `iva:${c.ivaPct}`;
  return c.inc ? "inc" : "none";
}

export function decodeLineTax(value: string): LineTaxChoice {
  const m = /^iva:(\d{1,3})(\+inc)?$/.exec(value);
  if (m) {
    const pct = Number(m[1]);
    return { ivaPct: pct >= 0 && pct <= 100 ? pct : 0, inc: Boolean(m[2]) };
  }
  return { ivaPct: 0, inc: value === "inc" };
}

/**
 * Consumo de la línea en centavos: % de su base (el neto, ya con los
 * descuentos) o el valor fijo digitado. Nunca negativo ni mayor que el tope.
 */
export function lineIncCents(netCents: number, inc: DiscountInput): number {
  let cents = 0;
  if (inc.pct != null && inc.pct > 0) cents = Math.round((Math.max(0, netCents) * Math.min(inc.pct, 100)) / 100);
  else if (inc.cents != null && inc.cents > 0) cents = Math.round(inc.cents);
  return Math.max(0, Math.min(cents, PURCHASE_MAX_CENTS));
}

/**
 * Consumo TOTAL de la línea (para lo pedido) con el que la recepción de
 * `receivedQty` lleva exactamente `receptionIncCents`: el consumo de una
 * línea se reparte por cantidad (`purchaseLineAmounts`). Exacto si se
 * recibe hasta lo pedido; recibiendo de más, el centavo más cercano posible.
 */
export function lineIncForReception(receptionIncCents: number, receivedQty: number, orderedQty: number): number {
  const inc = Math.max(0, Math.round(receptionIncCents));
  if (inc === 0) return 0;
  if (!(receivedQty > 0) || !(orderedQty > 0) || receivedQty === orderedQty) return inc;
  const r = BigInt(receivedQty);
  const guess = Number((BigInt(inc) * BigInt(orderedQty) + r / BigInt(2)) / r);
  for (const candidate of [guess, guess - 1, guess + 1]) {
    if (candidate >= 0 && proportionalCents(candidate, receivedQty, orderedQty) === inc) return candidate;
  }
  return guess;
}

/** Lo que hace falta de una línea de la orden para cambiarle el impuesto. */
export type ReceptionLineTaxItem = PurchaseLineAmountsInput & {
  taxPct: number;
  expectedTaxCents: number | null;
  expectedIncCents: number;
  qtyOrderedBase: number;
  receivedQtyBase: number;
  receivedCostCents: number;
};

/**
 * Impuesto documental de la línea cuando la factura de la entrega trae otro
 * (`override`: tarifa de IVA y consumo de ESTA entrega; null = el de la
 * orden). La misma cuenta en la pantalla y en el servidor:
 *  · misma tarifa ⇒ conserva el IVA documental de la orden; otra ⇒ la tarifa;
 *  · consumo igual al que ya le tocaba a la entrega ⇒ no cambia; si no, el
 *    total de la línea que reparte exactamente ese consumo a la entrega.
 * `changed` false ⇒ queda el de la orden (y no hay nada que fijar).
 */
export function receptionLineTax(
  item: ReceptionLineTaxItem,
  override: { taxPct?: number | null; incCents?: number | null },
  qtyBase: number,
  costCents: number,
) {
  const taxPct = override.taxPct == null ? item.taxPct : normalizeTaxPct(override.taxPct);
  const currentInc = purchaseLineAmounts(item, item.receivedCostCents + costCents, item.receivedQtyBase + qtyBase).incCents
    - receivedPurchaseLineAmounts(item).incCents;
  const expectedIncCents = override.incCents == null || override.incCents === currentInc
    ? item.expectedIncCents
    : lineIncForReception(override.incCents, qtyBase, item.qtyOrderedBase);
  return {
    changed: taxPct !== item.taxPct || expectedIncCents !== item.expectedIncCents,
    taxPct,
    // Otra tarifa ⇒ el IVA documental de la orden ya no aplica.
    expectedTaxCents: taxPct === item.taxPct ? item.expectedTaxCents : null,
    expectedIncCents,
  };
}

/** ¿Se le puede cambiar el impuesto a la línea? Solo sin nada recibido. */
export function lineTaxEditable(item: Pick<ReceptionLineTaxItem, "receivedQtyBase" | "receivedCostCents">): boolean {
  return item.receivedQtyBase <= 0 && item.receivedCostCents <= 0;
}
