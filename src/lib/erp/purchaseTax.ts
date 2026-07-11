// Impuestos (IVA) de compras (ERP F5) — LÓGICA PURA, sin DB. Importable
// por server y cliente. Convención: el costo de la línea que se guarda
// (expectedCostCents/receivedCostCents) es el NETO (sin IVA); el IVA y el
// bruto se derivan del taxPct. Filas viejas tienen taxPct 0 ⇒ neto = bruto.

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

export type TaxableLine = { costCents: number; taxPct: number };

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
    taxCents += lineTaxCents(l.costCents, l.taxPct);
  }
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** Tarifas de IVA válidas por país (para el picker). CO 0/5/19, MX 0/8/16. */
export function purchaseTaxRates(country: string | null | undefined): number[] {
  return country === "MX" ? [0, 8, 16] : [0, 5, 19];
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
