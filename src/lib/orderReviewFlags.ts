/**
 * «Revisar esta cuenta»: señales de que una cuenta ABIERTA puede ya no ser
 * del grupo que la abrió. Nace del incidente de un descuento de cliente que
 * quedó pegado: una cuenta con un plato, el mesero escogió en el cobro un
 * cliente con 20 %, el datáfono rechazó, el cobro se abandonó y, horas
 * después, otros comensales sentados en esa mesa recibían 20 % sobre todo.
 *
 * Señales (todas sobre rondas VIVAS, no canceladas):
 *
 *   1. `stale_customer_discount` — la cuenta tiene un descuento puesto por un
 *      cliente de facturación (`Order.discountBillingCustomerId`) y se montó
 *      al menos una ronda DESPUÉS de aplicarlo (`discountAppliedAt`).
 *   2. `failed_charge_still_open` — tiene un pago rechazado, ningún pago
 *      aprobado, y entró una ronda nueva después del último rechazo.
 *   3. `long_idle_reopened` — entró una ronda tras ≥ LONG_IDLE_REOPEN_MS sin
 *      rondas activas: desde la última ronda viva anterior o, si todas las
 *      anteriores están canceladas, desde la primera de ellas.
 *
 * Cada señal trae `since`: la ronda que la disparó. El «Mantener» del
 * personal (`Order.reviewAckAt`) apaga las señales con `since` hasta ese
 * instante; una señal nueva (otra ronda tras horas, otro rechazo) vuelve a
 * avisar. Quitar el descuento resuelve la 1; cobrar o cerrar la cuenta, todas.
 *
 * No aplica a mesas pseudo (número negativo: pickup) ni a facturas manuales,
 * ni a cuentas pagadas o canceladas.
 *
 * `newRoundAt`: evalúa como si se montara una ronda en ese instante (el
 * aviso ANTES de que el personal confirme una ronda nueva).
 *
 * Archivo puro (sin base de datos): se testea solo.
 */

/** Horas sin rondas activas a partir de las cuales una ronda nueva se revisa. */
export const LONG_IDLE_REOPEN_MS = 2 * 60 * 60 * 1000;

export type ReviewFlagKind =
  | "stale_customer_discount"
  | "failed_charge_still_open"
  | "long_idle_reopened";

export type ReviewFlag = { kind: ReviewFlagKind; since: Date };

export type ReviewFlagsInput = {
  status: string;
  tableNumber: number;
  tableKind: string | null;
  discountCents: number;
  discountPct: number | null;
  discountBillingCustomerId: string | null;
  discountAppliedAt: Date | null;
  reviewAckAt: Date | null;
  rounds: ReadonlyArray<{ placedAt: Date; status: string }>;
  payments: ReadonlyArray<{ status: string; createdAt: Date }>;
};

const CLOSED = new Set(["paid", "cancelled"]);

/** true si la cuenta entra en la revisión (cuenta viva de una mesa real). */
export function reviewApplies(input: Pick<ReviewFlagsInput, "status" | "tableNumber" | "tableKind">): boolean {
  if (CLOSED.has(input.status)) return false;
  if (input.tableNumber < 0) return false;
  if (input.tableKind === "manual" || input.tableKind === "pickup") return false;
  return true;
}

function earliestAfter(rounds: ReadonlyArray<{ placedAt: Date }>, after: Date): Date | null {
  let best: Date | null = null;
  for (const r of rounds) {
    if (r.placedAt.getTime() > after.getTime() && (!best || r.placedAt < best)) best = r.placedAt;
  }
  return best;
}

export function orderReviewFlags(
  input: ReviewFlagsInput,
  opts: { newRoundAt?: Date } = {},
): ReviewFlag[] {
  if (!reviewApplies(input)) return [];
  const all = [
    ...input.rounds,
    ...(opts.newRoundAt ? [{ placedAt: opts.newRoundAt, status: "placed" }] : []),
  ].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
  const live = all.filter((r) => r.status !== "cancelled");
  const flags: ReviewFlag[] = [];

  // 1. Descuento de un cliente con rondas montadas después de aplicarlo.
  const hasDiscount = input.discountCents > 0 || (input.discountPct ?? 0) > 0;
  if (input.discountBillingCustomerId && input.discountAppliedAt && hasDiscount) {
    const since = earliestAfter(live, input.discountAppliedAt);
    if (since) flags.push({ kind: "stale_customer_discount", since });
  }

  // 2. Cobro rechazado, nada aprobado, y una ronda nueva después del rechazo.
  const approved = input.payments.some((p) => p.status === "approved");
  const declines = input.payments.filter((p) => p.status === "declined");
  if (!approved && declines.length > 0) {
    const lastDecline = declines.reduce(
      (max, p) => (p.createdAt > max ? p.createdAt : max),
      declines[0].createdAt,
    );
    const since = earliestAfter(live, lastDecline);
    if (since) flags.push({ kind: "failed_charge_still_open", since });
  }

  // 3. Una ronda tras ≥ LONG_IDLE_REOPEN_MS sin rondas activas. Se toma la
  //    MÁS RECIENTE que lo cumpla: un «Mantener» apaga esa, y un hueco largo
  //    posterior vuelve a avisar.
  let idleSince: Date | null = null;
  for (const r of live) {
    const before = all.filter((p) => p !== r && p.placedAt.getTime() <= r.placedAt.getTime());
    if (!before.length) continue;
    const liveBefore = before.filter((p) => p.status !== "cancelled");
    const lastActive = liveBefore.length
      ? liveBefore[liveBefore.length - 1].placedAt
      : before[0].placedAt;
    if (r.placedAt.getTime() - lastActive.getTime() >= LONG_IDLE_REOPEN_MS) idleSince = r.placedAt;
  }
  if (idleSince) flags.push({ kind: "long_idle_reopened", since: idleSince });

  const ack = input.reviewAckAt;
  return ack ? flags.filter((f) => f.since.getTime() > ack.getTime()) : flags;
}
