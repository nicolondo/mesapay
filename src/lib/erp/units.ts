// Sistema de unidades del ERP (Fase A0).
//
// Diseño (spec 2026-07-03-erp-a0-fundaciones): cada insumo pertenece a UNA
// dimensión de medida (masa / volumen / conteo) y TODAS las cantidades se
// persisten como Int en la unidad base de esa dimensión:
//
//   mass   → gramo (g)      · display: g, kg (×1000)
//   volume → mililitro (ml) · display: ml, L (×1000)
//   count  → unidad (un)    · display: un
//
// "kg" y "L" son solo formato visual; los empaques de compra ("caja × 24",
// "bulto 50 kg") son presentaciones del proveedor con su contenido en unidad
// base — no unidades. Esto evita el caos receta-en-onzas / compra-en-libras /
// inventario-en-kilos: todo converge a la base.
//
// Los SÍMBOLOS (g, kg, ml, L, un) son iguales en es/en/pt — se tratan como
// notación, no como texto traducible. Los NOMBRES de dimensión ("Peso",
// "Volumen", "Unidades") sí van por i18n en la UI.

// Alineado con el enum Prisma MeasureKind (string literals para no importar
// @prisma/client en componentes cliente).
export type MeasureKind = "mass" | "volume" | "count";

export const MEASURE_KINDS: MeasureKind[] = ["mass", "volume", "count"];

/** Símbolo de la unidad base de cada dimensión. */
export const BASE_UNIT_SYMBOL: Record<MeasureKind, string> = {
  mass: "g",
  volume: "ml",
  count: "un",
};

export type DisplayUnit = {
  symbol: string;
  /** Cuántas unidades base es 1 de esta unidad. */
  factor: number;
};

/** Unidades en que la UI permite DIGITAR cantidades, por dimensión. */
export const DISPLAY_UNITS: Record<MeasureKind, DisplayUnit[]> = {
  mass: [
    { symbol: "g", factor: 1 },
    { symbol: "kg", factor: 1000 },
  ],
  volume: [
    { symbol: "ml", factor: 1 },
    { symbol: "L", factor: 1000 },
  ],
  count: [{ symbol: "un", factor: 1 }],
};

/**
 * Convierte un valor digitado (posiblemente decimal, ej. "2,5 kg") a la
 * unidad base como entero. Devuelve null si el resultado no es un entero
 * positivo razonable (p.ej. 0,0004 kg → 0.4 g no es representable).
 */
export function toBaseQty(
  value: number,
  kind: MeasureKind,
  unitSymbol: string,
): number | null {
  const unit = DISPLAY_UNITS[kind].find((u) => u.symbol === unitSymbol);
  if (!unit || !isFinite(value) || value <= 0) return null;
  const base = Math.round(value * unit.factor);
  if (base < 1 || base > 2_000_000_000) return null;
  // Rechazar pérdida de precisión real (0.15 un → 0; 0.0004 kg → 0.4 g).
  if (Math.abs(base - value * unit.factor) > 0.001) return null;
  return base;
}

/**
 * Formatea una cantidad en unidad base para mostrar, escalando a la unidad
 * grande cuando queda legible (2500 g → "2,5 kg"; 500 ml → "500 ml";
 * 24 un → "24 un"). Locale-aware para el separador decimal.
 */
export function formatBaseQty(
  baseQty: number,
  kind: MeasureKind,
  locale: string = "es",
): string {
  const units = DISPLAY_UNITS[kind];
  // Unidad más grande cuyo factor divide "legiblemente" la cantidad: usamos
  // la grande a partir de 1000 base (1 kg / 1 L), si no la base.
  const big = units[units.length - 1];
  const useBig = big.factor > 1 && baseQty >= big.factor;
  const unit = useBig ? big : units[0];
  const value = baseQty / unit.factor;
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: useBig ? 2 : 0,
  }).format(value);
  return `${formatted} ${unit.symbol}`;
}

/**
 * Costo por unidad base en centavos (float — solo para display/comparación,
 * nunca se persiste). Ej.: bulto 5000 g a $80.000 (8_000_000 ¢) → 1600 ¢/g.
 */
export function costPerBaseUnit(
  priceCents: number | null | undefined,
  contentQty: number,
): number | null {
  if (priceCents == null || priceCents < 0 || contentQty <= 0) return null;
  return priceCents / contentQty;
}
