// Vista del análisis de ventas: arma la página a partir del análisis ya
// cargado. Es un componente de servidor SÍNCRONO (recibe el traductor), así
// la misma vista se puede renderizar con datos simulados fuera de Next para
// revisar el diseño sin tocar la base.
import { ChartNavProvider, PendingFrame } from "@/components/charts/ChartNav";
import type { Locale } from "@/i18n/config";
import { SALES_EXPORT_PATH, salesFiltersToSearchParams } from "@/lib/salesAnalysis/filters";
import { allowedGranularities, rangeDays } from "@/lib/salesAnalysis/period";
import { buildHeatmap } from "@/lib/salesAnalysis/heatmap";
import { buildTrend } from "@/lib/salesAnalysis/trend";
import type { SalesAnalysis } from "@/lib/salesAnalysis/types";
import { categoryName, periodLabel, type Tr } from "@/lib/salesAnalysis/dimLabels";
import { fmtRange } from "@/lib/salesAnalysis/labels";
import { FilterBar } from "./FilterBar";
import { Breadcrumbs } from "./Breadcrumbs";
import { KpiGrid } from "./KpiGrid";
import { TrendPanel } from "./TrendPanel";
import { HeatmapPanel } from "./HeatmapPanel";
import { MixPanel } from "./MixPanel";
import { ProductsPanel } from "./ProductsPanel";
import { EngineeringPanel } from "./EngineeringPanel";
import { TeamPanel } from "./TeamPanel";
import { OrdersPanel } from "./OrdersPanel";
import { Definitions } from "./Definitions";

export function SalesAnalysisView({
  t,
  analysis,
  locale,
  currency,
  tenantName,
}: {
  t: Tr;
  analysis: SalesAnalysis;
  locale: Locale;
  currency: string;
  tenantName: string;
}) {
  const { filters, cutoffHour, counterMode, today } = analysis;
  const compareLabel = analysis.compareRange ? fmtRange(analysis.compareRange, locale) : null;
  const trend = buildTrend({
    rows: analysis.current.trend,
    range: analysis.range,
    compareRows: analysis.compare?.trend ?? null,
    compareRange: analysis.compareRange,
    granularity: analysis.granularity,
    cutoffHour,
  });
  const heat = buildHeatmap(analysis.heat, cutoffHour);
  const showHeat = rangeDays(analysis.range) >= 7;
  const exportQs = salesFiltersToSearchParams(filters);
  const exportHref = (format: "csv" | "xlsx") => {
    const sp = new URLSearchParams(exportQs);
    sp.set("formato", format);
    return `${SALES_EXPORT_PATH}?${sp.toString()}`;
  };
  const categoryLabels = Object.fromEntries(analysis.options.categories.map((c) => [c.id, categoryName(c, t)]));
  const margins = analysis.engineering
    ? Object.fromEntries(analysis.engineering.dishes.map((d) => [d.menuItemId, { unitMarginCents: d.unitMarginCents, marginPct: d.marginPct }]))
    : null;

  return (
    <ChartNavProvider>
      <div className="mp-page mp-viz-root mp-sales">
        <header className="mp-page-header">
          <div>
            <p className="mp-eyebrow">{tenantName}</p>
            <h1 className="mp-page-title">{t("title")}</h1>
            <p className="mp-page-description">{t("description")}</p>
          </div>
          <div className="mp-sales-export" role="group" aria-label={t("exportLabel")}>
            <a href={exportHref("xlsx")} className="mp-btn mp-btn--secondary" download>{t("exportExcel")}</a>
            <a href={exportHref("csv")} className="mp-btn mp-btn--secondary" download>{t("exportCsv")}</a>
          </div>
        </header>

        <Breadcrumbs t={t} filters={filters} options={analysis.options} locale={locale} counterMode={counterMode} />
        {/* La clave remonta la barra al navegar (drill, migas, atrás): sus
            campos locales —rango personalizado abierto, fechas— siguen a la URL. */}
        <FilterBar
          key={exportQs.toString()}
          filters={filters}
          range={analysis.range}
          granularity={analysis.granularity}
          allowedGranularities={allowedGranularities(analysis.range)}
          options={analysis.options}
          counterMode={counterMode}
          today={today}
        />

        <PendingFrame className="mp-sales-body">
          <p className="mp-sales-period" data-testid="sales-period">
            <strong>{periodLabel(filters, t, locale)}</strong>
            {filters.period !== "rango" && <span>{` · ${fmtRange(analysis.range, locale)}`}</span>}
            {compareLabel && <span>{` · ${t("comparedWith", { period: compareLabel })}`}</span>}
            <span className="mp-sales-period-hint">{t("businessDayHint", { hour: String(cutoffHour).padStart(2, "0") })}</span>
          </p>
          {analysis.itemFilter && <p className="mp-sales-callout" role="note">{t("itemFilterNotice")}</p>}

          <KpiGrid t={t} analysis={analysis} currency={currency} locale={locale} compareLabel={compareLabel} />

          <TrendPanel
            points={trend}
            granularity={analysis.granularity}
            range={analysis.range}
            filters={filters}
            currency={currency}
            hasCompare={analysis.compare !== null}
            compareLabel={compareLabel}
            today={today}
          />

          {/* Día × hora necesita al menos una semana para decir algo; en un
              día o unos pocos, la tendencia por hora ya lo muestra. */}
          <div className={`mp-sales-columns${showHeat ? "" : " mp-sales-columns--single"}`}>
            {showHeat && <HeatmapPanel heat={heat} filters={filters} currency={currency} />}
            <MixPanel
              methods={analysis.current.methods}
              compareMethods={analysis.compare?.methods ?? null}
              channels={analysis.current.channels}
              compareChannels={analysis.compare?.channels ?? null}
              tables={analysis.tables}
              filters={filters}
              currency={currency}
              counterMode={counterMode}
              itemFilter={analysis.itemFilter}
            />
          </div>

          <ProductsPanel
            products={analysis.current.products}
            compareProducts={analysis.compare?.products ?? null}
            categories={analysis.current.categories}
            compareCategories={analysis.compare?.categories ?? null}
            modifiers={analysis.modifiers}
            unsold={analysis.unsold}
            margins={margins}
            categoryLabels={categoryLabels}
            filters={filters}
            currency={currency}
          />

          {analysis.engineering && (
            <EngineeringPanel engineering={analysis.engineering} filters={filters} currency={currency} />
          )}

          <TeamPanel
            t={t}
            waiters={analysis.current.waiters}
            compareWaiters={analysis.compare?.waiters ?? null}
            filters={filters}
            currency={currency}
            locale={locale}
          />

          {analysis.orders && (
            <OrdersPanel
              t={t}
              orders={analysis.orders}
              truncated={analysis.ordersTruncated}
              currency={currency}
              locale={locale}
              counterMode={counterMode}
              itemFilter={analysis.itemFilter}
            />
          )}

          <Definitions t={t} cutoffHour={cutoffHour} />
        </PendingFrame>
      </div>
    </ChartNavProvider>
  );
}
