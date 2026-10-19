// Impuestos (IVA) de compras (ERP F5) — LÓGICA PURA, sin DB. Importable
// por server y cliente. Convención: el costo de la línea que se guarda
// (expectedCostCents/receivedCostCents) es el NETO, sin IVA ni consumo.
// IVA documental explícito prevalece sobre la tarifa; null conserva el
// cálculo anterior. Consumo es siempre un importe separado, nunca IVA.

/** IVA de la línea en centavos: round(neto × %/100). */
export function lineTaxCents(netCents: number, taxPct: number): number {
  if (!(taxPct > 0)) return 0;
  return Math.round((netCents * taxPct) / 100);
}

/** Bruto de la línea (lo que se paga): neto + IVA. */
export function lineGrossCents(netCents: number, taxPct: number): number {
  return netCents + lineTaxCents(netCents, taxPct);
}

/**
 * Valor que entra al inventario. Si el IVA es descontable, el costo es el
 * neto (el IVA va aparte); si no, es el bruto (el IVA es parte del costo).
 */
export function inventoryCostCents(
  netCents: number,
  taxPct: number,
  ivaDeductible: boolean,
): number {
  return ivaDeductible ? netCents : lineGrossCents(netCents, taxPct);
}

export type TaxableLine = {
  costCents: number;
  taxPct: number;
  /** IVA total documental. Cero explícito no es lo mismo que null. */
  taxCents?: number | null;
};

/** Totales de una OC/factura desde sus líneas netas + taxPct. */
export function poTotals(lines: TaxableLine[]): {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
} {
  let subtotalCents = 0;
  let taxCents = 0;
  for (const l of lines) {
    subtotalCents += l.costCents;
    taxCents += l.taxCents ?? lineTaxCents(l.costCents, l.taxPct);
  }
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** Campos monetarios inmutables de una línea y sus acumulados recibidos. */
export type PurchaseLineAmountsInput = {
  expectedCostCents?: number;
  expectedTaxCents?: number | null;
  expectedIncCents?: number;
  qtyOrderedBase?: number;
  taxPct: number;
  receivedCostCents?: number;
  receivedQtyBase?: number;
};

/** Prorrateo exacto de centavos positivos, con redondeo al entero más cercano. */
function proportionalCents(amount: number, part: number, whole: number): number {
  if (amount === 0 || part <= 0 || whole <= 0) return 0;
  const denominator = BigInt(whole);
  return Number((BigInt(amount) * BigInt(part) + denominator / BigInt(2)) / denominator);
}

/**
 * Importes de la línea completa o de una recepción ACUMULADA.
 * IVA explícito sigue el neto real; consumo fijo sigue la cantidad.
 * Para registrar una recepción, restar acumulado anterior del nuevo:
 * así tres recepciones no redondean tres veces el impuesto documental.
 */
export function purchaseLineAmounts(
  item: PurchaseLineAmountsInput,
  costCents = item.expectedCostCents ?? 0,
  qtyBase = item.qtyOrderedBase ?? 0,
) {
  const taxCents = item.expectedTaxCents == null
    ? lineTaxCents(costCents, item.taxPct)
    : proportionalCents(item.expectedTaxCents, costCents, item.expectedCostCents ?? 0);
  const incCents = proportionalCents(item.expectedIncCents ?? 0, qtyBase, item.qtyOrderedBase ?? 0);
  return { netCents: costCents, taxCents, incCents, totalCents: costCents + taxCents + incCents };
}

export function receivedPurchaseLineAmounts(item: PurchaseLineAmountsInput) {
  return purchaseLineAmounts(item, item.receivedCostCents ?? 0, item.receivedQtyBase ?? 0);
}

/** Neto sugerido para el siguiente lote, conservando centavos entre parciales.
 * Los precios reales anteriores no se compensan: sólo cuenta la cantidad.
 */
export function expectedReceiptCostCents(
  item: Pick<PurchaseLineAmountsInput, "expectedCostCents" | "qtyOrderedBase" | "receivedQtyBase">,
  qtyToReceive: number,
): number {
  const before = item.receivedQtyBase ?? 0;
  const expected = item.expectedCostCents ?? 0;
  const ordered = item.qtyOrderedBase ?? 0;
  return proportionalCents(expected, before + qtyToReceive, ordered)
    - proportionalCents(expected, before, ordered);
}

/** Campos que deben seleccionarse juntos para respetar los importes documentales. */
export const PURCHASE_LINE_AMOUNTS_SELECT = {
  expectedCostCents: true,
  expectedTaxCents: true,
  expectedIncCents: true,
  qtyOrderedBase: true,
  taxPct: true,
  receivedCostCents: true,
  receivedQtyBase: true,
} as const;

export type PurchaseOrderAmountsInput = Partial<InvoiceTaxExtras> & {
  items: readonly PurchaseLineAmountsInput[];
};

/**
 * Total de la OC/factura. incCents de cabecera YA incluye el consumo de
 * sus líneas: sólo su remanente no asignado se añade a los importes por
 * línea. Retenciones se descuentan una vez. En recepción parcial los
 * extras de cabecera siguen el avance de cantidades, ponderado al neto
 * esperado; una variación del precio real no cobra extras no recibidos.
 */
export function purchaseOrderTotals(
  order: PurchaseOrderAmountsInput,
  basis: "expected" | "received" = "expected",
) {
  const lines = order.items.map((item) => basis === "received"
    ? receivedPurchaseLineAmounts(item)
    : purchaseLineAmounts(item));
  const subtotalCents = lines.reduce((s, line) => s + line.netCents, 0);
  const taxCents = lines.reduce((s, line) => s + line.taxCents, 0);
  const allocatedInc = order.items.reduce((s, item) => s + (item.expectedIncCents ?? 0), 0);
  const unallocatedInc = Math.max(0, (order.incCents ?? 0) - allocatedInc);
  const weights = order.items.map((item) => {
    const whole = item.qtyOrderedBase ?? 0;
    const weight = item.expectedCostCents ?? item.receivedCostCents ?? 0;
    return {
      whole: weight,
      part: whole > 0
        ? proportionalCents(weight, Math.min(item.receivedQtyBase ?? 0, whole), whole)
        : Math.min(item.receivedCostCents ?? 0, weight),
    };
  });
  let whole = weights.reduce((s, w) => s + w.whole, 0);
  let part = weights.reduce((s, w) => s + w.part, 0);
  if (whole === 0) {
    whole = order.items.reduce((s, item) => s + (item.qtyOrderedBase ?? 0), 0);
    part = order.items.reduce((s, item) => s + Math.min(item.receivedQtyBase ?? 0, item.qtyOrderedBase ?? 0), 0);
  }
  const extra = (amount: number) => basis === "expected" ? amount : proportionalCents(amount, part, whole);
  const incCents = lines.reduce((s, line) => s + line.incCents, 0) + extra(unallocatedInc);
  const retention = extra((order.retefuenteCents ?? 0) + (order.reteIvaCents ?? 0) + (order.reteIcaCents ?? 0));
  return { subtotalCents, taxCents, incCents, retentionsCents: retention, totalCents: subtotalCents + taxCents + incCents - retention };
}

/** Tarifas de IVA válidas por país (para el picker). CO 0/5/19, MX 0/8/16. */
export function purchaseTaxRates(country: string | null | undefined): number[] {
  return country === "MX" ? [0, 8, 16] : [0, 5, 19];
}

/**
 * Otros impuestos de la factura además del IVA (ERP A3). INC se suma al
 * total; las retenciones se restan. Todos en centavos, positivos.
 */
export type InvoiceTaxExtras = {
  incCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
};

export const EMPTY_TAX_EXTRAS: InvoiceTaxExtras = {
  incCents: 0,
  retefuenteCents: 0,
  reteIvaCents: 0,
  reteIcaCents: 0,
};

/** Suma de retenciones (se restan del total a pagar). */
export function retentionsCents(x: InvoiceTaxExtras): number {
  return x.retefuenteCents + x.reteIvaCents + x.reteIcaCents;
}

/**
 * Total a pagar de la factura = subtotal (neto) + IVA + INC − retenciones.
 * Sirve para verificar contra el total impreso que leyó la IA.
 */
export function invoiceGrandTotalCents(
  subtotalCents: number,
  ivaCents: number,
  x: InvoiceTaxExtras,
): number {
  return subtotalCents + ivaCents + x.incCents - retentionsCents(x);
}

/** Normaliza un taxPct a entero 0–100 (0 si inválido). */
export function normalizeTaxPct(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isFinite(n) || n < 0 || n > 100) return 0;
  return Math.round(n);
}

/**
 * ¿Concuerda el total calculado (desde las líneas) con el total impreso
 * que leyó la IA? Tolera redondeo: difiere ≤ $1 (100 centavos) o ≤ 1%.
 * `printedTotalCents` null ⇒ no hay con qué comparar (concuerda por defecto).
 */
export function totalsMatch(
  computedTotalCents: number,
  printedTotalCents: number | null | undefined,
): boolean {
  if (printedTotalCents == null) return true;
  const diff = Math.abs(computedTotalCents - printedTotalCents);
  return diff <= 100 || diff <= printedTotalCents * 0.01;
}
