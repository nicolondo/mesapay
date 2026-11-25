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
 *
 * DOBLE VISTA (tercer pedido del dueño: "que esto siga así, pero que no se
 * desaparezcan de su ubicación original para poderlas ver en orden
 * también"). La vista de tarjetas de Mesas ya no usa UNA sola lista: arriba
 * va la sección de activas con este orden (`sortTablesForSalon` +
 * `isSalonTableActive`) y debajo el salón completo en su orden natural
 * (`sortTablesInSalonOrder`), donde cada mesa conserva su sitio de siempre.
 * Una mesa ocupada sale dos veces, y las dos apariciones son la misma mesa.
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
 * ¿Esta mesa va en la sección de arriba del salón? Son exactamente las que
 * `sortTablesForSalon` adelanta: las que tienen cuenta abierta y la que
 * acaba de pagar desde el celular mientras dure su resalte (va de primera
 * por pedido del dueño, y el tile dice "Pagó desde el celular", así que
 * acompaña a las activas en lugar de perder su sitio arriba).
 */
export function isSalonTableActive(
  t: SalonSortable,
  opts?: SalonSortOptions,
): boolean {
  return salonRank(t, opts) < RANK_EMPTY;
}

/** De vuelta del rango al estado visual, para los que piden acción. */
const RANK_STATE: Partial<Record<number, TableVisualState>> = {
  [RANK_DANGER]: "danger",
  [RANK_NEEDS_PAYMENT_URGENT]: "needs_payment_urgent",
  [RANK_NEEDS_PAYMENT]: "needs_payment",
};

/**
 * El estado visual MÁS urgente entre las mesas con cuenta abierta, o
 * `null` si ninguna pide acción. Misma precedencia que el orden
 * (URGENCY_RANK), así que lo que devuelve es el estado de la mesa que va
 * de primera en la sección «Activas».
 *
 * Lo usa el encabezado plegable de Mesas: con la sección cerrada no se ven
 * las tarjetas, así que el encabezado insinúa con un punto del mismo tono
 * que hay algo que atender. Ver MesasGrid.
 */
export function mostUrgentVisualState(
  tables: readonly SalonSortable[],
  opts?: SalonSortOptions,
): TableVisualState | null {
  let best = RANK_ACTIVE_PLAIN;
  for (const t of tables) {
    if (t.state !== "active") continue;
    const rank = salonRank(t, opts);
    if (rank < best) best = rank;
  }
  return RANK_STATE[best] ?? null;
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

/**
 * Orden natural del salón: el sitio de siempre de cada mesa (por número y,
 * de empate, por etiqueta). Ninguna mesa se adelanta por estar ocupada ni
 * por acabar de pagar — es la lista completa de la vista de tarjetas, la que
 * deja encontrar la mesa 7 entre la 6 y la 8 aunque esté ocupada.
 */
export function sortTablesInSalonOrder<
  T extends Pick<SalonSortable, "number" | "label">,
>(tables: readonly T[]): T[] {
  return [...tables].sort(compareTableIdentity);
}
