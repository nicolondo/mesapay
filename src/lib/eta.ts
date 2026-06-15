/**
 * ETA model: serial kitchen queue.
 *
 * We assume a single-cook/capacity-1 kitchen and walk the pending rounds in
 * FIFO order (placedAt asc). Within a round, dishes are prepared in parallel,
 * so the round's cook time is max(prepMinutes) across its items.
 *
 * This overestimates for kitchens that can cook multiple rounds in parallel,
 * which is the intentional bias: under-promising and over-delivering is a
 * better customer experience than missing a predicted time.
 */

export type EtaRoundInput = {
  id: string;
  status: string;
  placedAt: Date;
  kitchenStartedAt: Date | null;
  readyAt: Date | null;
  itemPrepMinutes: number[];
};

export type EtaResult = {
  etaAt: Date;
  minutesFromNow: number;
};

const MIN_REMAINING_MS = 60 * 1000;
// Una ronda que lleva más de esto en placed/in_kitchen sin avanzar a "ready"
// se considera ABANDONADA: pedido olvidado, ronda colgada o dato de prueba
// que nunca se sirvió. NO la metemos en la fila FIFO — si no, su tiempo de
// prep se sumaba al estimado de TODOS los pedidos nuevos e inflaba el ETA a
// valores absurdos (p.ej. ~227 min por una pila de rondas zombi). Sigue
// recibiendo un ETA propio (su prep, sin la cola) para no romper la UI.
const STALE_PENDING_MS = 90 * 60 * 1000;

function roundPrepMs(r: EtaRoundInput): number {
  if (r.itemPrepMinutes.length === 0) return 0;
  return Math.max(...r.itemPrepMinutes) * 60_000;
}

/**
 * Compute an ETA for every round in the queue. Rounds that are already
 * ready/served are returned with etaAt = readyAt (or now as a fallback).
 *
 * The input MUST contain every in-flight round for the restaurant so the
 * queue head is accurate — passing a single round's data would give a
 * wrong (always-zero-queue) answer.
 */
export function computeRoundEtas(
  rounds: EtaRoundInput[],
  now: Date = new Date(),
): Map<string, EtaResult> {
  const out = new Map<string, EtaResult>();
  const pending = rounds
    .filter((r) => r.status === "placed" || r.status === "in_kitchen")
    .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());

  let accMs = 0;
  for (const r of pending) {
    const prepMs = roundPrepMs(r);
    let remainingMs: number;
    if (r.status === "in_kitchen") {
      const startedAt = r.kitchenStartedAt ?? now;
      const elapsed = now.getTime() - startedAt.getTime();
      remainingMs = Math.max(prepMs - elapsed, MIN_REMAINING_MS);
    } else {
      remainingMs = prepMs;
    }
    // Ronda colgada (lleva demasiado en la fila sin avanzar): le damos un ETA
    // propio (su prep, desde ahora) pero NO la acumulamos — así no empuja el
    // estimado del resto de la cola.
    if (now.getTime() - r.placedAt.getTime() > STALE_PENDING_MS) {
      out.set(r.id, {
        etaAt: new Date(now.getTime() + remainingMs),
        minutesFromNow: Math.max(1, Math.ceil(remainingMs / 60_000)),
      });
      continue;
    }
    const etaAt = new Date(now.getTime() + accMs + remainingMs);
    out.set(r.id, {
      etaAt,
      minutesFromNow: Math.max(1, Math.ceil((etaAt.getTime() - now.getTime()) / 60_000)),
    });
    accMs += remainingMs;
  }

  for (const r of rounds) {
    if (out.has(r.id)) continue;
    if (r.status === "ready" || r.status === "served") {
      const etaAt = r.readyAt ?? now;
      out.set(r.id, { etaAt, minutesFromNow: 0 });
    }
  }

  return out;
}
