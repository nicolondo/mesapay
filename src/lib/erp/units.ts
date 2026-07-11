// Sistema de unidades del ERP (Fase A0).
//
// Diseño (spec 2026-07-03-erp-a0-fundaciones): cada insumo pertenece a UNA
// dimensión de medida (masa / volumen / conteo) y TODAS las cantidades se
// persisten como Int en la unidad base de esa dimensión:
//
//   mass   → gramo (g)          · display: g, kg (×1000)
//   volume → mililitro (ml)     · display: ml, L (×1000)
//   count  → milésima de unidad · display: un (×1000)
//
// La base de conteo es la MILÉSIMA de unidad (no la unidad): así "un" admite
// hasta 3 decimales — necesario para stock fraccionario real (botellas de
// licor abiertas: 25,94 un). Se sigue mostrando y digitando en "un"; la base
// milesimal es interna, igual que g/ml para masa/volumen.
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
  /** Máx. decimales al FORMATEAR en esta unidad (default: 2 si factor>1, 0 si no). */
  decimals?: number;
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
  // "un" = 1000 base (milésimas); admite hasta 3 decimales al mostrar.
  count: [{ symbol: "un", factor: 1000, decimals: 3 }],
};

/**
 * Factor de la unidad cuyo símbolo es BASE_UNIT_SYMBOL, por dimensión. Sirve
 * para mostrar el COSTO por esa unidad: el costo se guarda por unidad BASE
 * (por g/ml/milésima-de-un), así que para rotularlo "/un" (o /g, /ml) hay
 * que multiplicarlo por este factor. mass/volume = 1 (base = símbolo); count
 * = 1000 (base = milésima, símbolo = un).
 */
export const BASE_SYMBOL_FACTOR: Record<MeasureKind, number> = {
  mass: 1,
  volume: 1,
  count: 1000,
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
  // Rechazar pérdida de precisión real (0.0001 un → 0.1 milésima; 0.0004 kg
  // → 0.4 g). Con la base milesimal, "un" ya admite hasta 3 decimales.
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
  // Decimales según la unidad elegida (count "un" = 3; kg/L = 2; g/ml = 0).
  const maxFrac = unit.decimals ?? (unit.factor > 1 ? 2 : 0);
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: maxFrac,
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
