import { isOnlinePaymentMethod } from "@/lib/payments/methods";

/**
 * Mesa que acaba de pagar DESDE EL CELULAR (vista Mesas).
 *
 * Pedido del dueño: "cuando una mesa acaba de pagar directamente desde el
 * móvil quiero que salga en verde de primera en la lista de mesas por los
 * siguientes 3 minutos, para ver fácilmente que ya pagó cuando la gente se
 * está levantando de la mesa".
 *
 * El caso que importa es el que NADIE del equipo vio: el comensal escaneó el
 * QR, pagó con tarjeta / Apple Pay / Google Pay / PSE desde su celular y la
 * cuenta se cerró sola. Cuando un mesero cobra (efectivo, datáfono, o incluso
 * tarjeta desde su propia PWA) ya sabe que la mesa pagó: esa mesa sigue
 * saliendo como "recién pagada" (verde claro, 15 minutos), pero no sube ni se
 * resalta.
 *
 * Criterio — `wasPaidFromPhone`: el pago que CERRÓ la cuenta (el aprobado
 * más reciente) es de pasarela en línea (`isOnlinePaymentMethod`) y no tiene
 * `collectedByUserId` (ningún miembro del equipo lo inició). Se mira el que
 * cerró y no todos porque es el que decide si alguien del equipo se enteró
 * del cierre: si dos personas pagaron por celular y la tercera en efectivo al
 * mesero, el mesero sabe que la mesa quedó saldada.
 *
 * Ventana — `isPhonePaidHighlightActive`: desde `Order.paidAt`, durante los
 * minutos del comercio (`Restaurant.phonePaidHighlightMinutes`, default 3,
 * 0–30; 0 = apagado). El cliente la reevalúa con su propio reloj para que el
 * resalte caiga solo, sin esperar un refresh del servidor.
 *
 * Archivo sin dependencias de servidor: lo usan la página (server) y la
 * grilla (cliente).
 */

/** Minutos por defecto que una mesa pagada desde el celular queda resaltada. */
export const DEFAULT_PHONE_PAID_HIGHLIGHT_MINUTES = 3;
/** Rango aceptado del ajuste. 0 = no resaltar. */
export const PHONE_PAID_HIGHLIGHT_MIN_MINUTES = 0;
export const PHONE_PAID_HIGHLIGHT_MAX_MINUTES = 30;

/**
 * Normaliza lo guardado en el comercio: null/undefined o un valor inválido
 * caen al default; fuera de rango se recorta. Entero siempre.
 */
export function resolvePhonePaidHighlightMinutes(
  value: number | null | undefined,
): number {
  if (value == null || !Number.isFinite(value)) {
    return DEFAULT_PHONE_PAID_HIGHLIGHT_MINUTES;
  }
  const n = Math.trunc(value);
  return Math.min(
    PHONE_PAID_HIGHLIGHT_MAX_MINUTES,
    Math.max(PHONE_PAID_HIGHLIGHT_MIN_MINUTES, n),
  );
}

/** Lo que hace falta de cada pago de la cuenta para decidir quién la cerró. */
export type PhonePaidPayment = {
  method: string;
  status: string;
  /** Null = nadie del equipo inició el pago (lo hizo el comensal solo). */
  collectedByUserId: string | null;
  /** Cuándo se aprobó; si falta, cuándo se creó. */
  settledAt: Date | string | null;
  createdAt: Date | string;
};

const toMs = (d: Date | string | null | undefined): number =>
  d == null ? 0 : typeof d === "string" ? Date.parse(d) : d.getTime();

/** El pago aprobado más reciente (por `settledAt`, o `createdAt` si falta). */
export function closingPayment<P extends PhonePaidPayment>(
  payments: readonly P[],
): P | null {
  let best: P | null = null;
  let bestAt = -Infinity;
  for (const p of payments) {
    if (p.status !== "approved") continue;
    const at = toMs(p.settledAt ?? p.createdAt);
    // `>=`: a igual instante gana el último de la lista (orden de inserción).
    if (at >= bestAt) {
      best = p;
      bestAt = at;
    }
  }
  return best;
}

/**
 * ¿La cuenta la cerró el comensal desde su celular? Ver el criterio arriba.
 * Sin pagos aprobados (cortesía, cuenta en $0) → `false`.
 */
export function wasPaidFromPhone(
  payments: readonly PhonePaidPayment[],
): boolean {
  const closing = closingPayment(payments);
  if (!closing) return false;
  return isOnlinePaymentMethod(closing.method) && closing.collectedByUserId == null;
}

/**
 * ¿Sigue vigente el resalte? `minutes <= 0` apaga la función. Un `paidAt`
 * en el futuro (reloj del cliente atrasado) cuenta como recién pagado.
 */
export function isPhonePaidHighlightActive(
  paidAt: Date | string | number,
  now: number,
  minutes: number,
): boolean {
  if (!(minutes > 0)) return false;
  const paidMs = typeof paidAt === "number" ? paidAt : toMs(paidAt);
  if (!Number.isFinite(paidMs)) return false;
  const elapsed = Math.max(0, now - paidMs);
  return elapsed < minutes * 60_000;
}

/**
 * Minutos que CUALQUIER mesa recién pagada (la cobre quien la cobre) se ve
 * verde claro con ✓ en Mesas antes de volver a "libre".
 */
export const RECENTLY_PAID_MINUTES = 15;

/**
 * ¿Una mesa recién pagada se sigue dibujando como tal, o ya es "libre"?
 * Sí mientras no pasen los 15 minutos clásicos, o mientras siga vigente el
 * resalte de "pagó desde el celular" (que puede ser más largo). Misma regla
 * en el servidor (qué tile manda) y en el cliente (cuándo la deja caer sin
 * esperar un refresh).
 */
export function isRecentlyPaidVisible(
  paidAt: Date | string | number,
  now: number,
  opts: { paidFromPhone: boolean; phonePaidHighlightMinutes: number },
): boolean {
  const paidMs = typeof paidAt === "number" ? paidAt : toMs(paidAt);
  if (!Number.isFinite(paidMs)) return false;
  if (Math.max(0, now - paidMs) < RECENTLY_PAID_MINUTES * 60_000) return true;
  return (
    opts.paidFromPhone &&
    isPhonePaidHighlightActive(paidMs, now, opts.phonePaidHighlightMinutes)
  );
}

/** Minutos enteros desde el pago, nunca negativos (para "hace N min"). */
export function minutesSincePaid(
  paidAt: Date | string | number,
  now: number,
): number {
  const paidMs = typeof paidAt === "number" ? paidAt : toMs(paidAt);
  return Math.max(0, Math.floor((now - paidMs) / 60_000));
}
