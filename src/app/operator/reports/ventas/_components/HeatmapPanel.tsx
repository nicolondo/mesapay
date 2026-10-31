"use client";

// Dónde se concentra la venta: día de la semana (del día operativo) × hora.
// Clic en una celda = filtrar ese día y esa hora en todo el análisis.
import { useLocale, useTranslations } from "next-intl";
import { HeatmapGrid, type HeatGridCell } from "@/components/charts/HeatmapGrid";
import { formatValue } from "@/components/charts/format";
import { defaultLocale, isLocale } from "@/i18n/config";
import { salesHref, withDimension, type SalesFilters } from "@/lib/salesAnalysis/filters";
import { HEAT_LEVELS, type Heatmap } from "@/lib/salesAnalysis/heatmap";
import { fmtPercent, hourLabel, weekdayName } from "@/lib/salesAnalysis/labels";

export function HeatmapPanel({
  heat,
  filters,
  currency,
}: {
  heat: Heatmap;
  filters: SalesFilters;
  currency: string;
}) {
  const t = useTranslations("salesAnalysis");
  const localeValue = useLocale();
  const locale = isLocale(localeValue) ? localeValue : defaultLocale;
  const money = { kind: "money" as const, currency, locale };
  const count = { kind: "number" as const, locale };

  const cells: HeatGridCell[][] = heat.cells.map((row) =>
    row.map((c) => {
      const title = `${weekdayName(c.dow, locale, "long")} · ${hourLabel(c.hour)}`;
      const value = formatValue(c.netCents, money);
      return {
        level: c.level,
        ariaLabel: t("heat.cellAria", { slot: title, amount: value, orders: c.orders }),
        tooltip: {
          title,
          rows: [
            { value, label: t("kpi.net") },
            { value: formatValue(c.orders, count), label: t("kpi.orders") },
            ...(heat.totalNetCents > 0 && c.netCents > 0
              ? [{ value: fmtPercent(c.netCents / heat.totalNetCents, locale), label: t("shareOfTotal") }]
              : []),
          ],
          hint: c.orders > 0 ? t("heat.clickHint") : undefined,
        },
        href: c.orders > 0 ? salesHref(withDimension(withDimension(filters, "dia", c.dow), "hora", c.hour)) : undefined,
      };
    }),
  );

  const peakDay = heat.byDay.reduce((b, d) => (d.netCents > b.netCents ? d : b), heat.byDay[0]!);
  const peakHour = heat.byHour.reduce<(typeof heat.byHour)[number] | null>((b, h) => (h.netCents > (b?.netCents ?? -1) ? h : b), null);

  return (
    <section className="mp-panel mp-sales-panel" aria-labelledby="sales-heat-title">
      <div className="mp-panel-heading">
        <div>
          <h2 id="sales-heat-title">{t("heat.title")}</h2>
          <p className="mp-sales-sub">
            {heat.peak
              ? t("heat.summary", {
                  day: weekdayName(peakDay.dow, locale, "long"),
                  hour: peakHour ? hourLabel(peakHour.hour) : "",
                })
              : t("heat.subtitle")}
          </p>
        </div>
      </div>
      <div className="mp-sales-panel-body">
        {heat.hours.length === 0 ? (
          <div className="mp-viz-empty">{t("emptyPeriod")}</div>
        ) : (
          <HeatmapGrid
            rowLabels={heat.days.map((d) => weekdayName(d, locale))}
            colLabels={heat.hours.map((h) => String(h).padStart(2, "0"))}
            cells={cells}
            levels={HEAT_LEVELS}
            scaleLabels={{ low: t("heat.low"), high: t("heat.high"), none: t("heat.none") }}
            ariaLabel={t("heat.aria")}
          />
        )}
      </div>
      {heat.hours.length > 0 && (
        <details className="mp-chart-details">
          <summary>{t("tableView")}</summary>
          <div className="mp-sales-table-wrap">
            <table className="mp-sales-table">
              <thead>
                <tr>
                  <th scope="col">{t("dim.dia")}</th>
                  {heat.hours.map((h) => (
                    <th key={h} scope="col" className="num">{hourLabel(h)}</th>
                  ))}
                  <th scope="col" className="num">{t("total")}</th>
                </tr>
              </thead>
              <tbody>
                {heat.cells.map((row, i) => (
                  <tr key={heat.days[i]}>
                    <th scope="row">{weekdayName(heat.days[i]!, locale, "long")}</th>
                    {row.map((c) => (
                      <td key={c.hour} className="num">{c.netCents > 0 ? formatValue(c.netCents, money) : t("emptyDash")}</td>
                    ))}
                    <td className="num">{formatValue(heat.byDay[i]!.netCents, money)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
