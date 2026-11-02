import type { TableVisualState } from "@/lib/walkoutRisk";
import { isPhonePaidHighlightActive } from "./phonePaid";

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
 * ANTES DE TODO ESO va la mesa que ACABA DE PAGAR DESDE EL CELULAR (segundo
 * pedido del dueño: "que salga en verde de primera por los siguientes 3
 * minutos para ver que ya pagó cuando la gente se está levantando"). Es una
 * `recently_paid` con `paidFromPhone` cuyo `paidAt` sigue dentro de la
 * ventana del comercio (`phonePaidHighlightMinutes`, ver phonePaid.ts). Si
 * hay varias, la más reciente primero. Para evaluarla hace falta `now` y los
 * minutos: sin `opts`, ninguna mesa se adelanta (orden clásico).
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
  /** Sólo `recently_paid`: cuándo se pagó (ISO o Date). */
  paidAt?: string | Date | null;
  /** Sólo `recently_paid`: la cuenta la cerró el comensal desde su celular. */
  paidFromPhone?: boolean;
};

/** Lo que hace falta para decidir qué mesa "acaba de pagar desde el celular". */
export type SalonSortOptions = {
  /** Instante "ahora" en ms (del servidor o del reloj del cliente). */
  now: number;
  /** Minutos de resalte del comercio; 0 = ninguna mesa se adelanta. */
  phonePaidHighlightMinutes: number;
};

// Menor = más arriba.
const RANK_PHONE_PAID = -1;
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

/**
 * ¿Esta mesa acaba de pagar desde el celular y sigue en su ventana de
 * resalte? Es lo que la sube al principio y la pinta de verde fuerte.
 */
export function isPhonePaidHighlighted(
  t: Pick<SalonSortable, "state" | "paidAt" | "paidFromPhone">,
  opts: SalonSortOptions | undefined,
): boolean {
  if (!opts || t.state !== "recently_paid" || !t.paidFromPhone || t.paidAt == null) {
    return false;
  }
  return isPhonePaidHighlightActive(t.paidAt, opts.now, opts.phonePaidHighlightMinutes);
}

const paidAtMs = (t: Pick<SalonSortable, "paidAt">): number => {
  const v = t.paidAt;
  if (v == null) return 0;
  const ms = typeof v === "string" ? Date.parse(v) : v.getTime();
  return Number.isFinite(ms) ? ms : 0;
};

/** Grupo de orden de una mesa. Las activas siempre antes que las vacías. */
export function salonRank(t: SalonSortable, opts?: SalonSortOptions): number {
  if (isPhonePaidHighlighted(t, opts)) return RANK_PHONE_PAID;
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
  opts?: SalonSortOptions,
): T[] {
  return [...tables].sort((a, b) => {
    const ra = salonRank(a, opts);
    const rb = salonRank(b, opts);
    if (ra !== rb) return ra - rb;
    // Varias mesas acaban de pagar desde el celular: la más reciente primero
    // (la gente que se está levantando AHORA). A igual instante, por número.
    if (ra === RANK_PHONE_PAID) {
      const byRecency = paidAtMs(b) - paidAtMs(a);
      if (byRecency !== 0) return byRecency;
    }
    return compareTableIdentity(a, b);
  });
}
