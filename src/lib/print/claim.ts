/**
 * Reglas de ENTREGA de trabajos al agente de impresión.
 *
 * Todo lo que decide "qué se le da a este agente y qué no" vive acá,
 * separado de la ruta HTTP, porque es la lógica que hay que poder testear
 * sin una base de datos — y porque de ella depende la garantía
 * multi-tenant: un token de un restaurante NUNCA puede ver trabajos de
 * otro.
 */

import type { PrintJobStatus } from "@prisma/client";

/**
 * Cuánto esperamos antes de re-entregar un trabajo que se llevó un agente
 * y nunca confirmó. Es la ventana donde vive la incertidumbre: el PC se
 * pudo apagar entre "recibí los bytes" y "la impresora los escupió".
 *
 * 2 minutos: suficiente para que un socket a la impresora abra, escriba y
 * confirme aun con la red del local lenta, y corto para que si el PC se
 * reinició la comanda salga antes de que el plato esté frío.
 */
export const CLAIM_RETRY_MS = 2 * 60 * 1000;

/**
 * Tope de ENTREGAS de un mismo trabajo. Sin esto, un ticket que rompe la
 * impresora (papel atascado, un carácter que la cuelga) se reintentaría
 * para siempre y taparía la cola de todo lo demás.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Antigüedad máxima de un trabajo entregable. Una comanda de hace seis
 * horas ya no le sirve a nadie: si el PC de la cocina estuvo apagado todo
 * el servicio, al prenderlo NO queremos que escupa el servicio entero.
 * Los trabajos vencidos quedan en la tabla (sirven de auditoría) pero no
 * se entregan.
 */
export const JOB_TTL_MS = 6 * 60 * 60 * 1000;

/** Cuántos trabajos entrega como mucho un solo GET. */
export const DEFAULT_JOB_LIMIT = 10;
export const MAX_JOB_LIMIT = 50;

/**
 * Espera antes de reintentar tras un fallo reportado por el agente:
 * 30s por intento ya hecho. Con la impresora desconectada, los 5
 * intentos se reparten en ~5 minutos en vez de quemarse en medio minuto
 * — que es el tiempo que tarda alguien en volver a enchufarla.
 */
export function retryBackoffMs(attempts: number): number {
  return Math.max(1, attempts) * 30 * 1000;
}

/** Lo mínimo que hace falta saber de un trabajo para decidir si se entrega. */
export type ClaimableJob = {
  id: string;
  restaurantId: string;
  status: PrintJobStatus;
  attempts: number;
  createdAt: Date;
  deliveredAt: Date | null;
  nextAttemptAt: Date | null;
};

/**
 * Filtro que va a la DB. Deja pasar:
 *   - lo pendiente cuya espera de reintento ya venció, y
 *   - lo entregado hace más de CLAIM_RETRY_MS sin acuse,
 * siempre dentro del restaurante del token, sin pasarse del tope de
 * intentos y sin haber vencido.
 */
export function claimableWhere(restaurantId: string, now: Date) {
  return {
    restaurantId,
    attempts: { lt: MAX_ATTEMPTS },
    createdAt: { gte: new Date(now.getTime() - JOB_TTL_MS) },
    printer: { active: true },
    OR: [
      {
        status: "pending" as PrintJobStatus,
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      {
        status: "delivered" as PrintJobStatus,
        deliveredAt: { lt: new Date(now.getTime() - CLAIM_RETRY_MS) },
      },
    ],
  };
}

/**
 * Re-verifica en memoria lo que ya filtró la DB. Cinturón y tirantes, el
 * mismo criterio que usa `getDiner` en lib/dinerSession: la garantía de
 * que un restaurante no ve los trabajos de otro no puede depender de que
 * alguien se acuerde de poner el `where` correcto dentro de seis meses.
 *
 * Es puro a propósito — es lo que testeamos.
 */
export function selectClaimable(
  rows: ClaimableJob[],
  restaurantId: string,
  now: Date,
  limit: number = DEFAULT_JOB_LIMIT,
): ClaimableJob[] {
  const retryBefore = now.getTime() - CLAIM_RETRY_MS;
  const oldestAllowed = now.getTime() - JOB_TTL_MS;
  return rows
    .filter((job) => {
      if (job.restaurantId !== restaurantId) return false;
      if (job.attempts >= MAX_ATTEMPTS) return false;
      if (job.createdAt.getTime() < oldestAllowed) return false;
      if (job.status === "pending") {
        return !job.nextAttemptAt || job.nextAttemptAt.getTime() <= now.getTime();
      }
      if (job.status !== "delivered") return false;
      // Entregado y sin acuse: sólo se re-entrega pasada la ventana.
      return !!job.deliveredAt && job.deliveredAt.getTime() < retryBefore;
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, Math.max(0, limit));
}

/** Normaliza el `?limit=` que manda el agente. */
export function normalizeLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_JOB_LIMIT;
  return Math.min(MAX_JOB_LIMIT, n);
}

/**
 * ¿Un fallo reportado por el agente deja el trabajo listo para otro
 * intento, o se da por perdido? `attempts` es el contador YA incrementado
 * por la entrega que acaba de fallar.
 */
export function shouldRetryAfterFailure(attempts: number): boolean {
  return attempts < MAX_ATTEMPTS;
}
