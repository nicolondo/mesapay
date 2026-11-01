"use client";

import { useId } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney, localeTag } from "@/lib/format";
import type { IncomeClassification, IncomeMonth, IncomeSummary } from "@/lib/erp/reports/incomeStatement";

/**
 * Gráficas del estado de resultado, en SVG propio y sin librerías.
 * Portado de zenith `resultado-charts.tsx`:
 *
 *  · CASCADA: de los ingresos al resultado (ingresos, − costos, − gastos,
 *    − impuesto → resultado), barras horizontales con la misma escala;
 *  · BARRAS MENSUALES: ingresos, costos, gastos y resultado de cada mes
 *    del rango, agrupadas, con el eje cero para distinguir pérdidas.
 *
 * Solo GEOMETRÍA: las cifras vienen del mismo modelo que la tabla
 * (`buildIncomeStatement`). Si los importes no concilian con el resultado
 * (no puede pasar con centavos enteros, pero se comprueba), no se pintan.
 * Las gráficas no se imprimen (`no-print`): el papel lleva la tabla y el
 * resumen mensual, que tienen las cifras exactas.
 *
 * CELULAR (< 768px): la cascada se dibuja en una segunda geometría
 * «apilada» (rótulo y cifra en una línea, la barra debajo a todo el
 * ancho) porque el lienzo de 640 encogido a ~326px dejaba el texto en
 * 6px; las barras mensuales (hasta 12 meses × 4 series) se desplazan de
 * lado dentro de su tarjeta, con la leyenda envolviendo arriba.
 */
export type ChartMonth = IncomeMonth & { label: string };

const COLOR = {
  income: "var(--op-accent)",
  cost: "var(--gold)",
  expenses: "var(--olive)",
  tax: "var(--op-muted)",
  result: "var(--op-text)",
  negative: "var(--danger)",
  grid: "var(--op-border-2)",
  text: "var(--op-muted)",
} as const;

function domainOf(values: number[]): { min: number; max: number } {
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  return { min: min - span * 0.06, max: max + span * 0.06 };
}

type Step = { key: string; label: string; value: number; start: number; end: number; total: boolean };

function waterfallSteps(
  s: IncomeSummary,
  labels: Record<"income" | "cost" | "expenses" | "tax" | "result", string>,
  withTax: boolean,
): Step[] {
  let current = 0;
  const changes: [string, string, number][] = [
    ["income", labels.income, s.incomeCents],
    ["cost", labels.cost, -s.costCents],
    ["expenses", labels.expenses, -s.expensesCents],
    ...(withTax ? ([["tax", labels.tax, -s.incomeTaxCents]] as [string, string, number][]) : []),
  ];
  const steps = changes.map(([key, label, value]) => {
    const start = current;
    current += value;
    return { key, label, value, start, end: current, total: false };
  });
  steps.push({ key: "result", label: labels.result, value: s.resultCents, start: 0, end: s.resultCents, total: true });
  return steps;
}

/**
 * La cascada en dos geometrías. `stacked: false` (escritorio) es la
 * original: rótulo a la izquierda, barra al centro, cifra a la derecha, en
 * filas de 34 sobre un lienzo de 640. `stacked: true` (celular): lienzo de
 * 360 (≈ 326px reales, texto a ~11px), rótulo y cifra en la primera línea
 * y la barra debajo a todo el ancho. Cuál se ve lo decide el CSS
 * (`max-md:hidden` / `md:hidden`): un componente cliente no conoce el
 * ancho de la pantalla hasta hidratar.
 */
function Waterfall({
  steps,
  stacked,
  titleId,
  title,
  money,
  axis,
}: {
  steps: Step[];
  stacked: boolean;
  titleId: string;
  title: string;
  money: (c: number) => string;
  axis: (c: number) => string;
}) {
  const domain = domainOf(steps.flatMap((s) => [s.start, s.end]));
  const W = stacked ? 360 : 640;
  const ROW_H = stacked ? 46 : 34;
  const BAR_X0 = stacked ? 4 : 200;
  const BAR_X1 = stacked ? W - 4 : 520;
  const TEXT_Y = stacked ? 13 : ROW_H / 2 + 4;
  const BAR_Y = stacked ? 22 : 8;
  const BAR_H = stacked ? 14 : ROW_H - 16;
  const wx = (v: number) => BAR_X0 + ((v - domain.min) / (domain.max - domain.min)) * (BAR_X1 - BAR_X0);
  const height = steps.length * ROW_H + 24;
  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      className={stacked ? "mt-3 w-full md:hidden" : "mt-3 w-full max-md:hidden"}
      role="img"
      aria-labelledby={titleId}
    >
      <title id={titleId}>{title}</title>
      <line x1={wx(0)} y1={4} x2={wx(0)} y2={steps.length * ROW_H} stroke={COLOR.grid} strokeDasharray="3 4" />
      {steps.map((s, i) => {
        const y = i * ROW_H;
        const x0 = wx(Math.min(s.start, s.end));
        const x1 = wx(Math.max(s.start, s.end));
        const fill = s.total
          ? s.value < 0
            ? COLOR.negative
            : COLOR.result
          : s.value >= 0
            ? COLOR.income
            : COLOR.tax;
        return (
          <g key={s.key}>
            {s.total && <line x1={0} y1={y} x2={W} y2={y} stroke={COLOR.grid} />}
            <text
              x={0}
              y={y + TEXT_Y}
              fontSize="12"
              fill="currentColor"
              fontWeight={s.total ? 600 : 400}
            >
              {s.label}
            </text>
            <rect x={x0} y={y + BAR_Y} width={Math.max(1, x1 - x0)} height={BAR_H} rx="2" fill={fill}>
              <title>{`${s.label}: ${money(s.value)}`}</title>
            </rect>
            <text
              x={W - 4}
              y={y + TEXT_Y}
              fontSize="11"
              textAnchor="end"
              fill="currentColor"
              fontWeight={s.total ? 600 : 400}
              className="font-mono tabular"
            >
              {s.total || s.value === 0 ? money(s.value) : `${s.value > 0 ? "+" : ""}${money(s.value)}`}
            </text>
          </g>
        );
      })}
      <g fontSize="10" fill={COLOR.text}>
        <text x={BAR_X0} y={height - 6}>{axis(domain.min)}</text>
        <text x={wx(0)} y={height - 6} textAnchor="middle">0</text>
        <text x={BAR_X1} y={height - 6} textAnchor="end">{axis(domain.max)}</text>
      </g>
    </svg>
  );
}

export function IncomeCharts({
  summary,
  months,
  currency,
  classification,
  hasMovements,
}: {
  summary: IncomeSummary;
  months: ChartMonth[];
  currency: string;
  classification: IncomeClassification;
  hasMovements: boolean;
}) {
  const t = useTranslations("opReportes");
  const locale = useLocale() as Locale;
  const uid = useId();
  const money = (c: number) => formatMoney(c, { currency, locale });
  const compact = new Intl.NumberFormat(localeTag(locale), {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const axis = (c: number) => compact.format(c / 100);
  const pct = new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 });
  const co = classification === "co";

  const reconciles =
    summary.incomeCents - summary.costCents - summary.expensesCents - summary.incomeTaxCents ===
    summary.resultCents;
  if (!reconciles) {
    return (
      <p role="status" className="rounded-xl border border-op-border bg-op-surface px-4 py-3 text-sm text-op-muted">
        {t("isChartNotReconciled")}
      </p>
    );
  }
  const allZero = Object.values(summary).every((v) => v === 0);

  // ── Cascada ────────────────────────────────────────────────────────────
  const steps = waterfallSteps(
    summary,
    {
      income: t("isChartIncome"),
      cost: t("isChartCosts"),
      expenses: co ? t("isChartExpenses") : t("isChartExpensesGeneric"),
      tax: t("isChartTax"),
      result: t("isChartResult"),
    },
    co,
  );
  const ratio = summary.incomeCents > 0 ? (summary.resultCents / summary.incomeCents) * 100 : null;

  // ── Barras mensuales ───────────────────────────────────────────────────
  const series: { key: "incomeCents" | "costCents" | "expensesCents" | "resultCents"; label: string; color: string }[] = [
    { key: "incomeCents", label: t("isColIncome"), color: COLOR.income },
    { key: "costCents", label: t("isColCosts"), color: COLOR.cost },
    { key: "expensesCents", label: t("isColExpenses"), color: COLOR.expenses },
    { key: "resultCents", label: t("isColResult"), color: COLOR.result },
  ];
  const MW = 680;
  const MH = 260;
  const left = 58;
  const right = 12;
  const top = 16;
  const bottom = 36;
  const plotW = MW - left - right;
  const plotH = MH - top - bottom;
  const mDomain = domainOf(months.flatMap((m) => series.map((s) => m[s.key])));
  const my = (v: number) => top + ((mDomain.max - v) / (mDomain.max - mDomain.min)) * plotH;
  const groupW = months.length > 0 ? plotW / months.length : plotW;
  const barW = (groupW * 0.8) / series.length;
  const ticks = [...new Set([mDomain.min, 0, mDomain.max])];
  const labelEvery = Math.max(1, Math.ceil(months.length / 8));

  return (
    <section className="no-print min-w-0 space-y-4">
      {allZero && (
        <p className="text-sm text-op-muted">
          {hasMovements ? t("isChartAllZero") : t("isChartNoMovements")}
        </p>
      )}
      {/* `grid-cols-1` + `min-w-0` en las tarjetas: sin eso la pista
          implícita tomaba el min-content del SVG mensual (28rem) y la
          página se desplazaba de lado en el celular. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="min-w-0 rounded-2xl border border-op-border bg-op-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{t("isChartWaterfallTitle")}</h2>
              <p className="mt-1 text-xs text-op-muted">{t("isChartWaterfallDesc")}</p>
            </div>
            <span className="font-mono text-xs text-op-muted">{currency}</span>
          </div>
          <Waterfall
            steps={steps}
            stacked={false}
            titleId={`${uid}-wf`}
            title={t("isChartWaterfallTitle")}
            money={money}
            axis={axis}
          />
          <Waterfall
            steps={steps}
            stacked
            titleId={`${uid}-wfm`}
            title={t("isChartWaterfallTitle")}
            money={money}
            axis={axis}
          />
          <div className="mt-3 grid gap-3 border-t border-op-border pt-3 text-xs sm:grid-cols-2">
            <div className="min-w-0">
              <span className="block text-op-muted">{t("isStatMargin")}</span>
              <strong className="mt-1 block font-mono text-sm font-medium">
                {ratio == null ? t("isChartRatioNa") : `${pct.format(ratio)} %`}
              </strong>
            </div>
            {co && (
              <div className="min-w-0">
                <span className="block text-op-muted">{t("isChartOri")}</span>
                <strong className="mt-1 block font-mono text-sm font-medium">{money(summary.oriCents)}</strong>
                <span className="mt-1 block text-op-muted">
                  {t("isChartIntegral", { amount: money(summary.integralCents) })}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 rounded-2xl border border-op-border bg-op-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold">{t("isChartMonthlyTitle")}</h2>
              <p className="mt-1 text-xs text-op-muted">{t("isChartMonthlyDesc")}</p>
            </div>
            <span className="font-mono text-xs text-op-muted">{currency}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-hidden>
            {series.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
          {/* En el celular el lienzo mantiene 40rem (texto legible) y se
              desplaza dentro de la tarjeta; en md+ como antes (28rem). */}
          <div className="report-scroll mt-2">
            <svg
              viewBox={`0 0 ${MW} ${MH}`}
              className="w-full min-w-[40rem] md:min-w-[28rem]"
              role="img"
              aria-labelledby={`${uid}-m`}
            >
              <title id={`${uid}-m`}>{t("isChartMonthlyTitle")}</title>
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={left}
                    y1={my(tick)}
                    x2={MW - right}
                    y2={my(tick)}
                    stroke={COLOR.grid}
                    strokeDasharray={tick === 0 ? undefined : "3 4"}
                  />
                  <text x={left - 6} y={my(tick) + 4} textAnchor="end" fontSize="10" fill={COLOR.text}>
                    {axis(tick)}
                  </text>
                </g>
              ))}
              {months.map((m, i) => {
                const gx = left + i * groupW + groupW * 0.1;
                const showLabel = i % labelEvery === 0 || i === months.length - 1;
                return (
                  <g key={m.key}>
                    {series.map((s, j) => {
                      const v = m[s.key];
                      const y0 = my(0);
                      const y1 = my(v);
                      const fill = s.key === "resultCents" && v < 0 ? COLOR.negative : s.color;
                      return (
                        <rect
                          key={s.key}
                          x={gx + j * barW}
                          y={Math.min(y0, y1)}
                          width={Math.max(1, barW - 1)}
                          height={Math.max(v === 0 ? 0 : 1, Math.abs(y1 - y0))}
                          fill={fill}
                        >
                          <title>{`${s.label} · ${m.label}: ${money(v)}`}</title>
                        </rect>
                      );
                    })}
                    {showLabel && (
                      <text
                        x={gx + (groupW * 0.8) / 2}
                        y={MH - 12}
                        textAnchor="middle"
                        fontSize="10"
                        fill={COLOR.text}
                      >
                        {m.label}
                        {m.partial ? "*" : ""}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          {months.some((m) => m.partial) && (
            <p className="mt-2 text-xs text-op-muted">{t("isChartPartial")}</p>
          )}
        </div>
      </div>
    </section>
  );
}
