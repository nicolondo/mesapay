import type { TableVisualState } from "@/lib/walkoutRisk";

/**
 * Orden de las mesas del salón (/operator/tables y /mesero/mesas).
 *
 * Pedido del dueño: "que salgan de primero las mesas que están activas y
 * después en orden las que están vacías". Una mesa está ACTIVA cuando
 * tiene una cuenta abierta (Order con estado distinto de pagado/cancelado):
 * es lo que el grid ya marca como `state = "active"`. Las recién pagadas y
 * las libres no tienen cuenta viva → van después, por número.
 *
 * Dentro de las activas, primero las que piden acción de caja/mesero
 * (misma precedencia que el color del tile, ver computeVisualState):
 *
 *   1. danger               — riesgo de fuga sin pagar
 *   2. needs_payment_urgent — cuenta pedida / mesero llamado, ya envejecido
 *   3. needs_payment        — cuenta pedida / pago pendiente / mesero llamado
 *   4. el resto (cocinando, listo para servir, comiendo)
 *
 * y dentro de cada grupo por número de mesa. Función pura: no muta la
 * entrada y sirve para cualquier shape que tenga `number` + `state` (los
 * tiles del grid, o cualquier otra lista del salón).
 *
 * Las mesas `pickup` y `manual` no pasan por acá: viven en sus propias
 * secciones y el grid nunca las mezcla con las físicas.
 */

export type SalonSortable = {
  number: number;
  label?: string | null;
  state: "free" | "recently_paid" | "active";
  visualState?: TableVisualState;
  order?: { needsWaiter?: boolean } | null;
};

// Menor = más arriba.
const RANK_DANGER = 0;
const RANK_NEEDS_PAYMENT_URGENT = 1;
const RANK_NEEDS_PAYMENT = 2;
const RANK_ACTIVE_PLAIN = 3;
const RANK_EMPTY = 4;

const URGENCY_RANK: Partial<Record<TableVisualState, number>> = {
  danger: RANK_DANGER,
  needs_payment_urgent: RANK_NEEDS_PAYMENT_URGENT,
  needs_payment: RANK_NEEDS_PAYMENT,
};

/** Grupo de orden de una mesa. Las activas siempre antes que las vacías. */
export function salonRank(t: SalonSortable): number {
  if (t.state !== "active") return RANK_EMPTY;
  const byVisual = t.visualState
    ? (URGENCY_RANK[t.visualState] ?? RANK_ACTIVE_PLAIN)
    : RANK_ACTIVE_PLAIN;
  // Mesero llamado = pedido pendiente, aunque el estado visual no lo
  // refleje (computeVisualState ya lo sube a needs_payment; esto es la
  // red por si alguna lista arma el shape sin pasar por ahí).
  const byWaiter = t.order?.needsWaiter ? RANK_NEEDS_PAYMENT : RANK_ACTIVE_PLAIN;
  return Math.min(byVisual, byWaiter);
}

/**
 * Identidad de la mesa: número (siempre entero en el schema) y, de
 * empate, la etiqueta en orden alfabético natural ("Barra 2" < "Barra 10").
 * En la práctica el número es único por restaurante; la etiqueta sólo
 * desempata listas sintéticas o mezcladas.
 */
export function compareTableIdentity(
  a: Pick<SalonSortable, "number" | "label">,
  b: Pick<SalonSortable, "number" | "label">,
): number {
  if (a.number !== b.number) return a.number - b.number;
  return (a.label ?? "").localeCompare(b.label ?? "", undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortTablesForSalon<T extends SalonSortable>(
  tables: readonly T[],
): T[] {
  return [...tables].sort((a, b) => {
    const r = salonRank(a) - salonRank(b);
    if (r !== 0) return r;
    return compareTableIdentity(a, b);
  });
}
