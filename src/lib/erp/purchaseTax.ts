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
export function proportionalCents(amount: number, part: number, whole: number): number {
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

// ── IVA de compras: descontable o mayor valor del costo ────────────────────
//
// `Restaurant.purchaseIvaDeductible` decide, AL RECIBIR, si el IVA de la
// compra se descuenta (2408 IVA descontable) o es parte del costo, y la
// recepción congela esa decisión (`purchasing.receivePurchaseOrder`):
//   · líneas inventariables → el kardex: sin descontable la mercancía entra
//     al BRUTO (neto + consumo + IVA, `StockMovement.valueCents` del
//     `purchase_in`); con descontable, sin el IVA;
//   · líneas NO inventariables → `nonInventoryReceivedNonDeductibleTaxCents`
//     (va al gasto).
// Cambiar el ajuste después no reescribe compras ya recibidas: el reparto se
// LEE de lo congelado, nunca del ajuste de hoy. Estas funciones son la ÚNICA
// definición: la usan el asiento «Compras del día» (`posting.ts`, vía el
// libro de compras), el documental de «Impuestos del período», la exógena y
// la declaración, para que el libro y los reportes digan lo mismo.

/** Lo que hace falta de una línea recibida para repartir su IVA. */
export type ReceivedVatLineInput = PurchaseLineAmountsInput & {
  ingredientId?: string;
  /** Neto de las recepciones NO inventariables (congelado al recibir). */
  nonInventoryReceivedCostCents?: number;
  /** Consumo de las recepciones NO inventariables (congelado al recibir). */
  nonInventoryReceivedIncCents?: number;
  /** IVA no descontable de las recepciones NO inventariables (congelado al recibir). */
  nonInventoryReceivedNonDeductibleTaxCents?: number;
};

/** Un `purchase_in` de la compra en el kardex. */
export type PurchaseInMovement = { ingredientId: string; valueCents: number };

/** Lo que el kardex de una compra tiene que traer (filtro + campos). */
export const PURCHASE_IN_MOVEMENTS_SELECT = {
  where: { kind: "purchase_in" as const },
  select: { ingredientId: true, valueCents: true },
};

/** Campos de la línea que pide `capitalizedInventoryVatByLine` además de los importes. */
export const RECEIVED_VAT_LINE_SELECT = {
  ingredientId: true,
  nonInventoryReceivedCostCents: true,
  nonInventoryReceivedIncCents: true,
  nonInventoryReceivedNonDeductibleTaxCents: true,
} as const;

/** IVA de las recepciones INVENTARIABLES de la línea (el tope que el kardex pudo capitalizar). */
function inventoryLineVatCents(item: ReceivedVatLineInput): number {
  const frozen = item.nonInventoryReceivedNonDeductibleTaxCents ?? 0;
  return Math.max(0, receivedPurchaseLineAmounts(item).taxCents - frozen);
}

/**
 * IVA que la recepción CAPITALIZÓ en el inventario, línea por línea (mismo
 * orden que `items`): lo que el kardex de la compra valoró por encima del
 * neto + consumo de las recepciones inventariables. Con IVA descontable al
 * recibir es 0 (el kardex entró al neto y el IVA va a 2408); sin
 * descontable, el IVA de esas recepciones (va a 143505, no a 2408).
 *
 * Se agrupa por insumo (el `purchase_in` lleva el insumo, no la línea) y
 * nunca pasa del IVA de las recepciones inventariables de la línea. Las
 * recepciones anteriores al IVA documental (oct-2026) redondeaban el IVA por
 * entrega: en una compra recibida por partes puede quedar un centavo de
 * diferencia, que sigue el kardex (el inventario del libro = el del kardex).
 */
export function capitalizedInventoryVatByLine(
  items: readonly ReceivedVatLineInput[],
  movements: readonly PurchaseInMovement[],
): number[] {
  const out = items.map(() => 0);
  const groups = new Map<string, number[]>();
  items.forEach((item, i) => {
    const key = item.ingredientId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const stockByIngredient = new Map<string, number>();
  for (const m of movements) stockByIngredient.set(m.ingredientId, (stockByIngredient.get(m.ingredientId) ?? 0) + m.valueCents);
  for (const [ingredientId, idx] of groups) {
    const stock = stockByIngredient.get(ingredientId) ?? 0;
    if (stock <= 0) continue;
    let expected = 0;
    const caps = idx.map((i) => {
      const item = items[i]!;
      expected += (item.receivedCostCents ?? 0) - (item.nonInventoryReceivedCostCents ?? 0);
      expected += receivedPurchaseLineAmounts(item).incCents - (item.nonInventoryReceivedIncCents ?? 0);
      return inventoryLineVatCents(item);
    });
    const capTotal = caps.reduce((s, c) => s + c, 0);
    let left = Math.min(Math.max(0, stock - expected), capTotal);
    // Varias líneas del mismo insumo (raro): se llenan en orden, cada una
    // hasta su IVA. Como `left` ≤ Σ topes, se reparte entero.
    idx.forEach((i, k) => {
      const share = Math.min(caps[k]!, left);
      out[i] = share;
      left -= share;
    });
  }
  return out;
}

/**
 * IVA NO descontable de cada línea recibida (mismo orden que `items`): el de
 * las recepciones no inventariables (gasto, congelado en la línea) más el
 * que el kardex capitalizó en el inventario. Con IVA descontable al recibir
 * queda exactamente lo congelado de siempre.
 */
export function receivedNonDeductibleTaxByLine(
  items: readonly ReceivedVatLineInput[],
  movements: readonly PurchaseInMovement[],
): number[] {
  const capitalized = capitalizedInventoryVatByLine(items, movements);
  return items.map((item, i) => (item.nonInventoryReceivedNonDeductibleTaxCents ?? 0) + capitalized[i]!);
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
  /**
   * Parte de las retenciones practicada AL RECIBIR (compras manuales): ya
   * está sumada en retefuente/reteIva/reteIca y cuenta completa, sin seguir
   * el avance de la recepción. Ausente = 0 (todas siguen el avance).
   */
  receptionRetentionCents?: number;
  items: readonly PurchaseLineAmountsInput[];
};

/**
 * Impuestos de cabecera que `purchaseOrderTotals` necesita además de las
 * líneas. Seleccionarlos JUNTOS: sin `receptionRetentionCents`, una compra
 * recibida por partes con retenciones practicadas al recibir mostraría un
 * saldo por pagar de más.
 */
export const PURCHASE_ORDER_TAX_SELECT = {
  incCents: true,
  retefuenteCents: true,
  reteIvaCents: true,
  reteIcaCents: true,
  receptionRetentionCents: true,
} as const;

/**
 * Total de la OC/factura. incCents de cabecera YA incluye el consumo de
 * sus líneas: sólo su remanente no asignado se añade a los importes por
 * línea. Retenciones se descuentan una vez. En recepción parcial los
 * extras de cabecera siguen el avance de cantidades, ponderado al neto
 * esperado; una variación del precio real no cobra extras no recibidos.
 * Las retenciones practicadas en las recepciones (`receptionRetentionCents`)
 * ya son sobre lo recibido: cuentan completas.
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
  const allRetentions = (order.retefuenteCents ?? 0) + (order.reteIvaCents ?? 0) + (order.reteIcaCents ?? 0);
  const atReception = Math.min(allRetentions, Math.max(0, order.receptionRetentionCents ?? 0));
  const retention = extra(allRetentions - atReception) + atReception;
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

// ── Libro de compras: totales de un conjunto de filas ─────────────────────

/** Montos por factura del libro de compras (`accountingData.loadPurchasesBook`). */
export type PurchaseBookRowAmounts = {
  receivedCents: number;
  nonInventoryReceivedCents: number;
  nonInventoryNonDeductibleTaxCents: number;
  /**
   * IVA de las líneas inventariables que la recepción capitalizó en el
   * inventario (IVA de compras NO descontable al recibir): el asiento lo
   * debita a 143505 y no a 2408. 0 con IVA descontable. Ver
   * `capitalizedInventoryVatByLine`.
   */
  inventoryNonDeductibleTaxCents: number;
  nonInventoryIncCents: number;
  ivaCents: number;
  incCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
};

export type PurchaseBookTotals = PurchaseBookRowAmounts & { count: number };

/**
 * Suma las filas del libro de compras. La usan el libro (todas las del mes)
 * y el asiento «Compras del día» (las recibidas ese día): la misma cuenta
 * sobre cualquier subconjunto, así Σ días == mes al centavo.
 */
export function sumPurchaseBookRows(rows: readonly PurchaseBookRowAmounts[]): PurchaseBookTotals {
  const totals: PurchaseBookTotals = {
    count: rows.length,
    receivedCents: 0,
    nonInventoryReceivedCents: 0,
    nonInventoryNonDeductibleTaxCents: 0,
    inventoryNonDeductibleTaxCents: 0,
    nonInventoryIncCents: 0,
    ivaCents: 0,
    incCents: 0,
    retefuenteCents: 0,
    reteIvaCents: 0,
    reteIcaCents: 0,
  };
  for (const r of rows) {
    totals.receivedCents += r.receivedCents;
    totals.nonInventoryReceivedCents += r.nonInventoryReceivedCents;
    totals.nonInventoryNonDeductibleTaxCents += r.nonInventoryNonDeductibleTaxCents;
    totals.inventoryNonDeductibleTaxCents += r.inventoryNonDeductibleTaxCents ?? 0;
    totals.nonInventoryIncCents += r.nonInventoryIncCents;
    totals.ivaCents += r.ivaCents;
    totals.incCents += r.incCents;
    totals.retefuenteCents += r.retefuenteCents;
    totals.reteIvaCents += r.reteIvaCents;
    totals.reteIcaCents += r.reteIcaCents;
  }
  return totals;
}
