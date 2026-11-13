// Tope de una LÍNEA LIBRE (cargo o servicio) — lógica pura, sin DB ni React.
//
// La usan el diálogo «Agregar cargo o servicio» (para avisar ANTES de enviar)
// y la API `POST /api/operator/order-items` (que es la que manda). Si cada
// lado calculara por su cuenta, el mesero vería un máximo y el servidor
// aplicaría otro.
//
// Antes era un tope FIJO de $10.000.000 por línea: un evento de ~$12 millones
// con impoconsumo incluido dejaba el botón apagado sin decir por qué, aunque
// la cuenta estaba vacía y cabía de sobra. Ahora el tope es DINÁMICO: la
// línea puede valer lo que quede libre en la cuenta sin pasar el techo seguro
// del total.
//
// Por qué hay techo: `Order.subtotalCents/taxCents/totalCents/tipCents`,
// `Payment.amountCents`, `SimpleInvoice.totalCents` y `CreditNote.*` son
// `Int` de Postgres (máx. 2.147.483.647 centavos ≈ $21.474.836). Pasarse no
// es un error de negocio: es un 500 al guardar — o peor, al registrar el pago
// que confirma el banco. Ver el plan de BigInt en el PR.

import { lineTaxOnTopCents, orderTaxTotals, type TaxedLine } from "@/lib/salesTax";
import { MAX_TIP_PCT } from "@/lib/tips";

/**
 * Techo seguro del total de una cuenta (comida + impuesto encima + propina),
 * en centavos: $20.000.000.
 *
 * No es el máximo del `Int` (2.147.483.647) sino el máximo de UN pago
 * (`amountCentsSchema` en `payments/validation.ts`, igual en efectivo,
 * datáfono, tarjeta y PSE). Así la cuenta entera, con la propina más alta
 * que deja elegir el cobro, se puede pagar de una sola vez por cualquier
 * medio, y a todas las columnas `Int` les queda aire (~7 %) por debajo de su
 * límite.
 */
export const SAFE_ORDER_TOTAL_CENTS = 2_000_000_000;

/**
 * Margen reservado para la propina, en % de lo cobrable. Es la propina
 * MÁXIMA que el cobro deja elegir (`MAX_TIP_PCT`, 30 %): no hay una regla de
 * propina por comercio, así que se usa la de la plataforma. Con ese margen,
 * una cuenta al tope sigue cabiendo aunque el cliente deje la propina más
 * alta posible.
 */
export const FREE_LINE_TIP_MARGIN_PCT = MAX_TIP_PCT;

/**
 * Valor máximo del precio unitario que acepta la API (validación de forma).
 * El tope real es el dinámico; esto sólo evita números absurdos antes de
 * hacer cuentas.
 */
export const MAX_FREE_LINE_UNIT_CENTS = SAFE_ORDER_TOTAL_CENTS;

/** Lo que la cuenta ya tiene, tal como está guardado en `Order`. */
export type OrderRoomInput = {
  /**
   * Σ de las líneas vivas ANTES del descuento del comensal. El descuento NO
   * se descuenta del tope a propósito: es un % que se puede quitar después
   * («Quitar descuento») y entonces el total subiría; además el subtotal
   * bruto también es una columna `Int`.
   */
  subtotalCents: number;
  /** Impuesto que las líneas libres ya suman encima (`Order.taxCents`). */
  taxCents: number;
  /** Propina ya cobrada (`Order.tipCents`). 0 en una cuenta que se puede editar. */
  tipCents: number;
};

/**
 * Lo que la cuenta tiene, armado desde sus líneas vivas — para el diálogo,
 * que tiene los platos y los cargos pero no los totales guardados. Es la
 * MISMA cuenta que hace el servidor al recalcular (`recomputeOrderLinesInTx`):
 * subtotal = Σ líneas; impuesto = lo que las líneas libres suman encima.
 */
export function orderRoomFromLines(
  lines: readonly TaxedLine[],
  tipCents = 0,
): OrderRoomInput {
  const t = orderTaxTotals([...lines], { kind: "none", pct: 0 });
  return { subtotalCents: t.subtotalCents, taxCents: t.taxOnTopCents, tipCents };
}

/** Impuesto elegido para la línea: `taxKind` null ⇒ incluido en el precio. */
export type FreeLineTax = { taxKind: string | null; taxPct: number | null };

/**
 * Cuánto más puede crecer lo COBRABLE de la cuenta (línea + su impuesto
 * encima) sin que el total, con la propina máxima, pase el techo seguro.
 */
export function freeLineChargeableRoomCents(order: OrderRoomInput): number {
  const tip = Math.max(0, order.tipCents);
  const maxChargeable = Math.floor(
    ((SAFE_ORDER_TOTAL_CENTS - tip) * 100) / (100 + FREE_LINE_TIP_MARGIN_PCT),
  );
  return Math.max(
    0,
    maxChargeable - Math.max(0, order.subtotalCents) - Math.max(0, order.taxCents),
  );
}

/** ¿Una línea de `amountCents` con ese impuesto cabe en la cuenta? */
export function freeLineFits(
  order: OrderRoomInput,
  line: FreeLineTax & { amountCents: number },
): boolean {
  if (!Number.isSafeInteger(line.amountCents) || line.amountCents < 0) return false;
  const tax = lineTaxOnTopCents(line);
  return line.amountCents + tax <= freeLineChargeableRoomCents(order);
}

/**
 * Valor máximo de la línea (precio unitario × cantidad, ANTES del impuesto
 * que se suma encima) que cabe en esta cuenta con ese impuesto. Con el
 * impuesto incluido es el espacio libre tal cual; con IVA 19 % encima es ese
 * espacio / 1,19.
 */
export function maxFreeLineCents(order: OrderRoomInput, tax: FreeLineTax): number {
  const room = freeLineChargeableRoomCents(order);
  if (room <= 0) return 0;
  // Mismo criterio que `lineTaxOnTopCents`: incluido (null) o "none" no suman.
  const pct =
    tax.taxKind != null && tax.taxKind !== "none" ? Math.max(0, tax.taxPct ?? 0) : 0;
  let max = Math.floor((room * 100) / (100 + pct));
  // El impuesto se redondea al centavo (`lineTaxOnTopCents`): se ajusta el
  // borde para que el máximo devuelto SIEMPRE quepa y el siguiente centavo no.
  const fits = (c: number) =>
    c + lineTaxOnTopCents({ amountCents: c, ...tax }) <= room;
  while (max > 0 && !fits(max)) max--;
  while (fits(max + 1)) max++;
  return max;
}

/**
 * El máximo para mostrarle a quien digita: en pesos ENTEROS (el campo de
 * precio no admite centavos), redondeado hacia abajo para que escribir
 * exactamente ese número siempre pase.
 */
export function maxFreeLineDisplayCents(maxCents: number): number {
  return Math.max(0, Math.floor(maxCents / 100) * 100);
}
