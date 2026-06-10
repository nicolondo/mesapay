/**
 * Helpers puros para el cálculo de comisiones de comerciales.
 * Sin dependencias de BD — aptos para tests unitarios simples.
 */

// ── resolveCommissionBps ──────────────────────────────────────────────────────

/**
 * Cascada de resolución de tasa de comisión (basis points):
 *   1. Override por comercio (Restaurant.salesRepCommissionBps)
 *   2. Default del comercial (User.commissionBps)
 *   3. Default global de plataforma (PlatformConfig.salesCommissionBps)
 *
 * Se usa `!= null` para tratar tanto null como undefined como "sin override".
 * El valor 0 se acepta como override explícito válido.
 */
export function resolveCommissionBps(opts: {
  restaurantBps: number | null | undefined;
  repBps: number | null | undefined;
  platformBps: number;
}): number {
  if (opts.restaurantBps != null) return opts.restaurantBps;
  if (opts.repBps != null) return opts.repBps;
  return opts.platformBps;
}

// ── commissionAmountCents ────────────────────────────────────────────────────

/**
 * Calcula el monto de comisión en centavos aplicando round half-up.
 * Fórmula: floor(base * bps / 10000 + 0.5)
 * Nunca retorna un valor negativo (base < 0 → 0).
 */
export function commissionAmountCents(
  baseAmountCents: number,
  bps: number,
): number {
  if (baseAmountCents <= 0) return 0;
  return Math.floor((baseAmountCents * bps) / 10_000 + 0.5);
}

// ── summarizeCommissions ─────────────────────────────────────────────────────

export type CommissionRow = {
  amountCents: number;
  status: "pending" | "paid" | "reversed";
  createdAt: Date;
};

type MonthSummary = {
  month: string; // "YYYY-MM"
  pendingCents: number;
  paidCents: number;
};

type CommissionSummary = {
  pendingCents: number;
  paidCents: number;
  reversedCents: number;
  byMonth: MonthSummary[];
};

/**
 * Agrega filas de comisión en totales globales y por mes.
 * byMonth contiene sólo pending + paid (reversed es un ajuste contable
 * y no se proyecta por mes). El orden de byMonth es ascendente por mes.
 */
export function summarizeCommissions(rows: CommissionRow[]): CommissionSummary {
  let pendingCents = 0;
  let paidCents = 0;
  let reversedCents = 0;
  const monthMap = new Map<string, MonthSummary>();

  for (const row of rows) {
    const month = toYearMonth(row.createdAt);

    if (!monthMap.has(month)) {
      monthMap.set(month, { month, pendingCents: 0, paidCents: 0 });
    }
    const bucket = monthMap.get(month)!;

    if (row.status === "pending") {
      pendingCents += row.amountCents;
      bucket.pendingCents += row.amountCents;
    } else if (row.status === "paid") {
      paidCents += row.amountCents;
      bucket.paidCents += row.amountCents;
    } else {
      // reversed
      reversedCents += row.amountCents;
      // No sumamos al bucket — reversed no se proyecta en byMonth
    }
  }

  const byMonth = Array.from(monthMap.values()).sort((a, b) =>
    a.month.localeCompare(b.month),
  );

  return { pendingCents, paidCents, reversedCents, byMonth };
}

// ── helpers internos ─────────────────────────────────────────────────────────

function toYearMonth(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
