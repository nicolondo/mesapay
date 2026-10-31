"use client";

// Tendencia del período con la comparación superpuesta. Se elige qué medir
// (venta neta, cuentas o ticket) y un clic en un día, semana o mes entra a
// ese tramo (en vista por hora, filtra esa hora). La tabla de abajo trae los
// mismos números sin depender del gráfico.
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { LineChart, type LinePoint } from "@/components/charts/LineChart";
import { formatValue, type ValueFormat } from "@/components/charts/format";
import { ChartLink } from "@/components/charts/ChartNav";
import { defaultLocale, isLocale } from "@/i18n/config";
import { drillToRange, salesHref, withDimension, type SalesFilters } from "@/lib/salesAnalysis/filters";
import { bucketRange, type DayRange, type Granularity } from "@/lib/salesAnalysis/period";
import { pointTicket, type TrendPoint } from "@/lib/salesAnalysis/trend";
import { bucketLabel, fmtDelta } from "@/lib/salesAnalysis/labels";
import { variation } from "@/lib/salesAnalysis/compare";

type Metric = "net" | "orders" | "ticket";

export function TrendPanel({
  points,
  granularity,
  range,
  filters,
  currency,
  hasCompare,
  compareLabel,
  today,
}: {
  points: TrendPoint[];
  granularity: Granularity;
  range: DayRange;
  filters: SalesFilters;
  currency: string;
  hasCompare: boolean;
  compareLabel: string | null;
  /** Día operativo de hoy: su balde todavía está en curso. */
  today: string;
}) {
  const t = useTranslations("salesAnalysis");
  const localeValue = useLocale();
  const locale = isLocale(localeValue) ? localeValue : defaultLocale;
  const [metric, setMetric] = useState<Metric>("net");
  const money: ValueFormat = { kind: "money", currency, locale };
  const count: ValueFormat = { kind: "number", locale };
  const format = metric === "orders" ? count : money;

  const valueOf = (net: number | null, orders: number | null) =>
    metric === "net" ? net : metric === "orders" ? orders : pointTicket(net, orders);

  const hrefOf = (p: TrendPoint) => {
    if (granularity === "hora") {
      const hour = Number(p.bucket.slice(11, 13));
      return salesHref(withDimension(filters, "hora", hour));
    }
    const r = bucketRange(p.bucket, granularity, range);
    if (r.from === range.from && r.to === range.to) return undefined;
    return salesHref(drillToRange(filters, r));
  };

  const labelOf = (key: string) => {
    const l = bucketLabel(key, granularity, locale);
    return { short: l.short, long: l.weekOf ? t("weekOf", { date: l.weekOf }) : l.long };
  };
  /** El balde de hoy no está cerrado: se avisa para que una caída no asuste. */
  const inProgress = (key: string) => {
    if (granularity === "hora") return false;
    const r = bucketRange(key, granularity, range);
    return r.from <= today && today <= r.to;
  };

  const linePoints: LinePoint[] = points.map((p) => {
    const l = labelOf(p.bucket);
    return {
      key: p.bucket,
      label: inProgress(p.bucket) ? t("trend.inProgress", { label: l.long }) : l.long,
      shortLabel: l.short,
      value: valueOf(p.netCents, p.orders) ?? 0,
      compare: hasCompare ? valueOf(p.compareNetCents, p.compareOrders) : null,
      compareLabel: p.compareBucket ? labelOf(p.compareBucket).long : null,
      extra: [
        ...(metric !== "orders" ? [{ value: formatValue(p.orders, count), label: t("trend.ordersRow") }] : []),
        ...(metric !== "net" ? [{ value: formatValue(p.netCents, money), label: t("trend.netRow") }] : []),
      ],
      href: hrefOf(p),
    };
  });

  const hint = granularity === "hora" ? t("trend.clickHour") : granularity === "dia" ? t("trend.clickDay") : t("trend.clickRange");
  const total = points.reduce((s, p) => s + p.netCents, 0);
  const best = points.reduce<TrendPoint | null>((b, p) => (p.netCents > (b?.netCents ?? -1) ? p : b), null);

  return (
    <section className="mp-panel mp-sa-panel" aria-labelledby="sales-trend-title">
      <div className="mp-panel-heading">
        <div>
          <h2 id="sales-trend-title">{t("trend.title")}</h2>
          <p className="mp-sales-sub">
            {best && best.netCents > 0
              ? t("trend.best", { label: labelOf(best.bucket).long, amount: formatValue(best.netCents, money) })
              : t("trend.subtitle")}
          </p>
        </div>
        <div className="mp-seg" role="radiogroup" aria-label={t("trend.metricLabel")}>
          {(["net", "orders", "ticket"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={metric === m} data-active={metric === m || undefined} className="mp-seg__i" onClick={() => setMetric(m)}>
              {t(`trend.metric.${m}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="mp-sales-panel-body">
        {total === 0 && points.every((p) => !p.compareNetCents) ? (
          <div className="mp-viz-empty">{t("emptyPeriod")}</div>
        ) : (
          <LineChart
            points={linePoints}
            format={format}
            seriesLabel={t("trend.current")}
            compareSeriesLabel={hasCompare ? compareLabel ?? t("trend.compare") : null}
            ariaLabel={t("trend.aria", { metric: t(`trend.metric.${metric}`) })}
            hint={hint}
          />
        )}
      </div>
      <details className="mp-chart-details">
        <summary>{t("tableView")}</summary>
        <div className="mp-sales-table-wrap">
          <table className="mp-sales-table">
            <thead>
              <tr>
                <th scope="col">{t(`granularity.${granularity}`)}</th>
                <th scope="col" className="num">{t("trend.metric.net")}</th>
                <th scope="col" className="num">{t("trend.metric.orders")}</th>
                <th scope="col" className="num">{t("trend.metric.ticket")}</th>
                {hasCompare && <th scope="col" className="num">{t("trend.compareNet")}</th>}
                {hasCompare && <th scope="col" className="num">{t("variation")}</th>}
              </tr>
            </thead>
            <tbody>
              {points.map((p) => {
                const href = hrefOf(p);
                const label = labelOf(p.bucket).long;
                const d = hasCompare ? variation(p.netCents, p.compareNetCents) : null;
                const ticket = pointTicket(p.netCents, p.orders);
                return (
                  <tr key={p.bucket}>
                    <th scope="row">{href ? <ChartLink href={href} className="mp-text-link">{label}</ChartLink> : label}</th>
                    <td className="num">{formatValue(p.netCents, money)}</td>
                    <td className="num">{formatValue(p.orders, count)}</td>
                    <td className="num">{ticket === null ? t("emptyDash") : formatValue(ticket, money)}</td>
                    {hasCompare && <td className="num">{p.compareNetCents === null ? t("emptyDash") : formatValue(p.compareNetCents, money)}</td>}
                    {hasCompare && <td className="num">{d === null ? t("emptyDash") : fmtDelta(d, locale)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
