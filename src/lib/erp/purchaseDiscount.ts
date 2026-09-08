// Descuentos de compra (por línea y sobre el total) — LÓGICA PURA, sin DB.
//
// Convención del módulo de compras: el costo que se PERSISTE en la línea
// (expectedCostCents / receivedCostCents) es el NETO QUE SE PAGA, ya con el
// descuento adentro. De ahí cuelgan el IVA, el costo de inventario, la CxP y
// la contabilidad — ver purchaseTax.ts. Así, agregar descuentos no cambia
// nada aguas abajo: sólo cambia CÓMO se llega a ese neto.
//
// Lo que se guarda además (precio de lista + descuento) es para poder
// mostrar "subtotal / descuento / total" como lo trae la factura del
// proveedor y para reconstruir lo que se digitó.

export type DiscountInput = {
  /** Porcentaje 0–100. Tiene prioridad sobre `cents` si viene definido. */
  pct?: number | null;
  /** Valor fijo en centavos. */
  cents?: number | null;
};

/** ¿El descuento digitado es distinto de "sin descuento"? */
export function hasDiscount(d: DiscountInput): boolean {
  return (d.pct != null && d.pct > 0) || (d.cents != null && d.cents > 0);
}

/**
 * Descuento en centavos sobre una base. El % manda si viene; si no, el valor
 * fijo. Nunca negativo ni mayor que la base — un descuento no puede dejar la
 * línea por debajo de cero.
 */
export function discountAmountCents(
  baseCents: number,
  d: DiscountInput,
): number {
  if (baseCents <= 0) return 0;
  let amount: number;
  if (d.pct != null && d.pct > 0) {
    amount = Math.round((baseCents * Math.min(d.pct, 100)) / 100);
  } else if (d.cents != null && d.cents > 0) {
    amount = Math.round(d.cents);
  } else {
    return 0;
  }
  return Math.max(0, Math.min(amount, baseCents));
}

/**
 * Reparte un descuento global entre las líneas, proporcional a su base.
 *
 * El reparto DEBE sumar exactamente el descuento pedido: si se redondea cada
 * parte por separado se pierden o sobran centavos y el total de la OC deja de
 * cuadrar con la factura. Se usa el método del resto mayor — las líneas con
 * la fracción más grande se llevan el centavo sobrante.
 */
export function prorateDiscount(
  totalDiscountCents: number,
  lineBases: number[],
): number[] {
  const n = lineBases.length;
  if (n === 0) return [];
  const sum = lineBases.reduce((s, b) => s + Math.max(0, b), 0);
  if (totalDiscountCents <= 0 || sum <= 0) return new Array(n).fill(0);

  const capped = Math.min(totalDiscountCents, sum);
  const exact = lineBases.map((b) => (Math.max(0, b) * capped) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let left = capped - floors.reduce((s, x) => s + x, 0);

  // Reparte el resto por fracción descendente; ante empate, la línea de base
  // mayor primero, para que el reparto sea estable y reproducible.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x), base: Math.max(0, lineBases[i]!) }))
    .sort((a, b) => b.frac - a.frac || b.base - a.base || a.i - b.i);

  const out = [...floors];
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

export type DiscountedLine = {
  /** Neto de lista, antes de cualquier descuento. */
  listCents: number;
  /** Descuento propio de la línea. */
  discount: DiscountInput;
};

export type ResolvedLine = {
  listCents: number;
  /** Descuento de la línea. */
  lineDiscountCents: number;
  /** Parte del descuento global que le tocó. */
  orderDiscountCents: number;
  /** Lo que se paga por la línea: lista − ambos descuentos. Es el que se persiste. */
  netCents: number;
};

/**
 * Resuelve toda la OC: aplica el descuento de cada línea y después prorratea
 * el descuento global sobre lo que quedó. El global se calcula sobre el
 * subtotal YA descontado por línea — es como se lee una factura: primero el
 * descuento del ítem, después el del pie.
 */
export function resolveOrderDiscounts(
  lines: DiscountedLine[],
  orderDiscount: DiscountInput,
): { lines: ResolvedLine[]; subtotalCents: number; discountCents: number; netCents: number } {
  const lineDiscounts = lines.map((l) =>
    discountAmountCents(l.listCents, l.discount),
  );
  const afterLine = lines.map((l, i) => l.listCents - lineDiscounts[i]!);
  const afterLineSum = afterLine.reduce((s, x) => s + x, 0);

  const orderTotal = discountAmountCents(afterLineSum, orderDiscount);
  const orderParts = prorateDiscount(orderTotal, afterLine);

  const resolved: ResolvedLine[] = lines.map((l, i) => ({
    listCents: l.listCents,
    lineDiscountCents: lineDiscounts[i]!,
    orderDiscountCents: orderParts[i]!,
    netCents: afterLine[i]! - orderParts[i]!,
  }));

  const subtotalCents = lines.reduce((s, l) => s + l.listCents, 0);
  const discountCents = subtotalCents - resolved.reduce((s, l) => s + l.netCents, 0);
  return {
    lines: resolved,
    subtotalCents,
    discountCents,
    netCents: subtotalCents - discountCents,
  };
}
