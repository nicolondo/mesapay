// Comparaciones del análisis de ventas (variación, tono del delta y
// participación) — LÓGICA PURA y SIN dependencias, para poder usarse en los
// componentes de cliente sin arrastrar código de servidor.
import type { KpiKey } from "./metrics";

/**
 * Variación relativa contra la comparación. null cuando no se puede decir
 * nada honesto: sin comparación, sin dato o con base cero.
 */
export function variation(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

/** Si subir es bueno, malo o ninguna de las dos (para el color del delta). */
export type Polarity = "up" | "down" | "neutral";

/** "good" | "bad" | "neutral" según el signo de la variación y la polaridad. */
export function deltaTone(delta: number | null, polarity: Polarity): "good" | "bad" | "neutral" {
  if (delta === null || delta === 0 || polarity === "neutral") return "neutral";
  const up = delta > 0;
  return up === (polarity === "up") ? "good" : "bad";
}

/** Participación sobre el total (0–1); null con total cero. */
export function share(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

/** Polaridad de cada indicador: subir la venta es bueno; subir los descuentos, no. */
export const KPI_POLARITY: Record<KpiKey, Polarity> = {
  netCents: "up",
  grossCents: "up",
  taxCents: "neutral",
  tipCents: "up",
  discountCents: "down",
  compsCents: "down",
  discountsAndCompsCents: "down",
  returnsCents: "down",
  netAfterReturnsCents: "up",
  orders: "up",
  diners: "up",
  avgTicketCents: "up",
  avgPerDinerCents: "up",
  unitsPerOrder: "up",
  medianTableMinutes: "neutral",
};
