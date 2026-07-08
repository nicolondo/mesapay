// Contabilidad operativa (ERP Fase B2) — LÓGICA PURA, sin DB.
//
// El caller (API) consulta los agregados (ventas, consumo, mermas,
// gastos, compras) y acá se arma el P&L, se serializa el CSV y se decide
// qué plantillas de gasto recurrente materializar. Todo en centavos
// enteros; los % con 1 decimal.

/** [desde, hasta) en UTC para un mes "YYYY-MM". null si el input no es válido. */
export function monthRange(month: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (year < 2020 || year > 2100 || mon < 1 || mon > 12) return null;
  return {
    from: new Date(Date.UTC(year, mon - 1, 1)),
    to: new Date(Date.UTC(year, mon, 1)),
  };
}

/** % sobre base con 1 decimal; null si la base es 0 (no inventar 0%). */
export function pctOf(partCents: number, baseCents: number): number | null {
  if (baseCents === 0) return null;
  return Math.round((partCents / baseCents) * 1000) / 10;
}

export type PnlInputs = {
  /** Σ subtotalCents de órdenes pagadas del mes. */
  salesCents: number;
  /** Σ tipCents (informativo — no es ingreso del negocio). */
  tipsCents: number;
  /** Σ taxCents (informativo — el IVA formal llega con B1). */
  taxesCents: number;
  /** Σ |valueCents| de sale_consumption del mes (ledger A4). */
  consumptionCents: number;
  /** Σ |valueCents| de waste del mes. */
  wasteCents: number;
  /** Gastos del mes por categoría. */
  expensesByCategory: Array<{ category: string; amountCents: number }>;
  /** Σ recibido de OCs del mes (informativo — el costo entra vía CMV). */
  purchasesReceivedCents: number;
  /**
   * C1 — costo laboral del mes (null = módulo staff apagado: el P&L no
   * cambia). Real = turnos punchados; estimado = planeados sin punch.
   */
  labor?: LaborSummary | null;
};

export type LaborSummary = {
  totalCents: number;
  actualCents: number;
  estimatedCents: number;
  /** C2 — parte del total que es recargo festivo/dominical. */
  surchargeCents: number;
  shifts: number;
  /** Turnos de empleados sin tarifa (costaron 0 — badge en UI). */
  missingRateShifts: number;
  /** C2 — faltas del mes (modo estricto; cuestan 0). */
  absentShifts: number;
};

export type Pnl = PnlInputs & {
  expensesCents: number;
  grossProfitCents: number;
  grossMarginPct: number | null;
  operatingProfitCents: number;
  operatingMarginPct: number | null;
  /** C1 — (CMV + mermas + laboral) / ingresos. null sin módulo staff o sin ventas. */
  primeCostPct: number | null;
};

export function buildPnl(i: PnlInputs): Pnl {
  const expensesCents = i.expensesByCategory.reduce(
    (s, e) => s + e.amountCents,
    0,
  );
  const grossProfitCents = i.salesCents - i.consumptionCents - i.wasteCents;
  const laborCents = i.labor?.totalCents ?? 0;
  const operatingProfitCents = grossProfitCents - laborCents - expensesCents;
  return {
    ...i,
    labor: i.labor ?? null,
    expensesByCategory: [...i.expensesByCategory].sort(
      (a, b) => b.amountCents - a.amountCents,
    ),
    expensesCents,
    grossProfitCents,
    grossMarginPct: pctOf(grossProfitCents, i.salesCents),
    operatingProfitCents,
    operatingMarginPct: pctOf(operatingProfitCents, i.salesCents),
    primeCostPct: i.labor
      ? pctOf(i.consumptionCents + i.wasteCents + laborCents, i.salesCents)
      : null,
  };
}

// ── CSV (RFC 4180 + BOM para Excel) ────────────────────────────────────────

function csvCell(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serializa filas a CSV con BOM UTF-8 (Excel muestra bien los acentos).
 * Montos: el caller ya los convierte a unidades de moneda (no centavos).
 */
export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

/** Centavos → unidades de moneda con 2 decimales y punto (para CSV). */
export function centsToCsvAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

// ── Gastos recurrentes ──────────────────────────────────────────────────────

export type RecurringTemplate = {
  id: string;
  recurringDay: number;
};

/**
 * Qué plantillas tocan HOY y aún no tienen copia este mes. Pura: el cron
 * consulta plantillas + copias del mes y escribe las que salgan de acá.
 *
 * Regla del día: materializa cuando day-of-month (UTC) == recurringDay.
 * recurringDay se valida 1-28 en la API, así que todos los meses tienen
 * el día — sin casos de febrero.
 */
export function materializeRecurring(
  templates: RecurringTemplate[],
  copiesThisMonthByTemplateId: Set<string>,
  today: Date,
): string[] {
  const day = today.getUTCDate();
  return templates
    .filter(
      (t) => t.recurringDay === day && !copiesThisMonthByTemplateId.has(t.id),
    )
    .map((t) => t.id);
}
