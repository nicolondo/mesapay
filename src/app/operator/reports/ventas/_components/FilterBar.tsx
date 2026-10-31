"use client";

// Filtros globales en UNA fila sobre todo lo que filtran: período (presets y
// rango personalizado), comparación, granularidad y dimensiones. Cada cambio
// navega a la URL nueva (todo el estado vive en la URL) y los gráficos se
// quedan atenuados mientras llega la página.
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useChartNav } from "@/components/charts/ChartNav";
import { defaultLocale, isLocale } from "@/i18n/config";
import {
  CHANNELS,
  DIMENSIONS,
  NO_WAITER,
  REPORTING_METHODS,
  normalizeRange,
  parseDimension,
  salesHref,
  withDimension,
  withoutDimension,
  withPeriod,
  type Dimension,
  type SalesFilters,
} from "@/lib/salesAnalysis/filters";
import { COMPARE_MODES, PERIOD_PRESETS, type DayRange, type Granularity } from "@/lib/salesAnalysis/period";
import type { FilterOptions } from "@/lib/salesAnalysis/types";
import { categoryName, channelLabel, dimName, dimValueLabel, methodLabel, tableName } from "@/lib/salesAnalysis/dimLabels";
import { hourLabel, weekdayName } from "@/lib/salesAnalysis/labels";

const inputClass =
  "h-10 w-full min-w-0 rounded-xl border border-op-border bg-op-surface px-3 text-sm text-op-text focus:outline-none focus:ring-2 focus:ring-op-accent";

export function FilterBar({
  filters,
  range,
  granularity,
  allowedGranularities,
  options,
  counterMode,
  today,
}: {
  filters: SalesFilters;
  range: DayRange;
  granularity: Granularity;
  allowedGranularities: Granularity[];
  options: FilterOptions;
  counterMode: boolean;
  today: string;
}) {
  const t = useTranslations("salesAnalysis");
  const localeValue = useLocale();
  const locale = isLocale(localeValue) ? localeValue : defaultLocale;
  const { navigate } = useChartNav();
  const [custom, setCustom] = useState(filters.period === "rango");
  const [desde, setDesde] = useState(range.from);
  const [hasta, setHasta] = useState(range.to);
  const [open, setOpen] = useState(false);
  const go = (next: SalesFilters) => navigate(salesHref(next));

  const setDim = (dim: Dimension, raw: string) => {
    if (raw === "") return go(withoutDimension(filters, dim));
    const value = parseDimension(dim, raw);
    if (value !== undefined) go(withDimension(filters, dim, value as never));
  };

  const products = filters.dims.categoria
    ? options.products.filter((p) => p.categoryId === filters.dims.categoria)
    : options.products;
  const activeDims = filters.dimOrder.filter((d) => filters.dims[d] !== undefined);
  const labelCtx = { t, locale, options, counterMode };

  return (
    <section aria-label={t("filtersLabel")} className="mp-sales-filters">
      <div className="mp-sales-filter-row">
        <label className="mp-sales-field">
          <span>{t("periodLabel")}</span>
          <select
            className={inputClass}
            value={custom ? "rango" : filters.period}
            onChange={(e) => {
              if (e.target.value === "rango") {
                setCustom(true);
                return;
              }
              setCustom(false);
              go(withPeriod(filters, e.target.value as (typeof PERIOD_PRESETS)[number]));
            }}
          >
            {PERIOD_PRESETS.map((p) => (
              <option key={p} value={p}>{t(`period.${p}`)}</option>
            ))}
            <option value="rango">{t("period.rango")}</option>
          </select>
        </label>
        {custom && (
          <form
            className="mp-sales-range"
            onSubmit={(e) => {
              e.preventDefault();
              const r = normalizeRange(desde, hasta);
              if (r) go(withPeriod(filters, "rango", r));
            }}
          >
            <label className="mp-sales-field">
              <span>{t("from")}</span>
              <input type="date" className={inputClass} value={desde} max={today} onChange={(e) => setDesde(e.target.value)} required />
            </label>
            <label className="mp-sales-field">
              <span>{t("to")}</span>
              <input type="date" className={inputClass} value={hasta} max={today} onChange={(e) => setHasta(e.target.value)} required />
            </label>
            <button type="submit" className="mp-btn mp-btn--primary mp-sales-apply">{t("apply")}</button>
          </form>
        )}
        <label className="mp-sales-field">
          <span>{t("compareLabel")}</span>
          <select className={inputClass} value={filters.compare} onChange={(e) => go({ ...filters, compare: e.target.value as SalesFilters["compare"] })}>
            {COMPARE_MODES.map((m) => (
              <option key={m} value={m}>{t(`compare.${m}`)}</option>
            ))}
          </select>
        </label>
        {allowedGranularities.length > 1 && (
          <div className="mp-sales-field">
            <span id="sales-granularity">{t("granularityLabel")}</span>
            <div className="mp-seg" role="radiogroup" aria-labelledby="sales-granularity">
              {allowedGranularities.map((g) => (
                <button
                  key={g}
                  type="button"
                  role="radio"
                  aria-checked={g === granularity}
                  data-active={g === granularity || undefined}
                  className="mp-seg__i"
                  onClick={() => go({ ...filters, granularity: g })}
                >
                  {t(`granularity.${g}`)}
                </button>
              ))}
            </div>
          </div>
        )}
        <button type="button" className="mp-btn mp-btn--secondary mp-sales-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {activeDims.length > 0 ? t("moreFiltersCount", { count: activeDims.length }) : t("moreFilters")}
        </button>
      </div>

      <div className="mp-sales-dims" data-open={open || undefined}>
        <label className="mp-sales-field">
          <span>{dimName("canal", t)}</span>
          <select className={inputClass} value={filters.dims.canal ?? ""} onChange={(e) => setDim("canal", e.target.value)}>
            <option value="">{t("all")}</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>{channelLabel(c, t, counterMode)}</option>
            ))}
          </select>
        </label>
        <label className="mp-sales-field">
          <span>{dimName("mesero", t)}</span>
          <select className={inputClass} value={filters.dims.mesero ?? ""} onChange={(e) => setDim("mesero", e.target.value)}>
            <option value="">{t("all")}</option>
            {options.waiters.map((w) => (
              <option key={w.id} value={w.id}>{w.disabled ? t("disabledWaiter", { name: w.name }) : w.name}</option>
            ))}
            <option value={NO_WAITER}>{t("noWaiter")}</option>
          </select>
        </label>
        <label className="mp-sales-field">
          <span>{dimName("categoria", t)}</span>
          <select className={inputClass} value={filters.dims.categoria ?? ""} onChange={(e) => setDim("categoria", e.target.value)}>
            <option value="">{t("all")}</option>
            {options.categories.map((c) => (
              <option key={c.id} value={c.id}>{categoryName(c, t)}</option>
            ))}
          </select>
        </label>
        <label className="mp-sales-field">
          <span>{dimName("producto", t)}</span>
          <select className={inputClass} value={filters.dims.producto ?? ""} onChange={(e) => setDim("producto", e.target.value)}>
            <option value="">{t("all")}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="mp-sales-field">
          <span>{dimName("pago", t)}</span>
          <select className={inputClass} value={filters.dims.pago ?? ""} onChange={(e) => setDim("pago", e.target.value)}>
            <option value="">{t("all")}</option>
            {REPORTING_METHODS.map((m) => (
              <option key={m} value={m}>{methodLabel(m, t)}</option>
            ))}
          </select>
        </label>
        {!counterMode && options.tables.length > 0 && (
          <label className="mp-sales-field">
            <span>{dimName("mesa", t)}</span>
            <select className={inputClass} value={filters.dims.mesa ?? ""} onChange={(e) => setDim("mesa", e.target.value)}>
              <option value="">{t("all")}</option>
              {options.tables.map((x) => (
                <option key={x.id} value={x.id}>{tableName(x, t)}</option>
              ))}
            </select>
          </label>
        )}
        <label className="mp-sales-field">
          <span>{dimName("dia", t)}</span>
          <select className={inputClass} value={filters.dims.dia ?? ""} onChange={(e) => setDim("dia", e.target.value)}>
            <option value="">{t("all")}</option>
            {[1, 2, 3, 4, 5, 6, 7].map((d) => (
              <option key={d} value={d}>{weekdayName(d, locale, "long")}</option>
            ))}
          </select>
        </label>
        <label className="mp-sales-field">
          <span>{dimName("hora", t)}</span>
          <select className={inputClass} value={filters.dims.hora ?? ""} onChange={(e) => setDim("hora", e.target.value)}>
            <option value="">{t("all")}</option>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{hourLabel(h)}</option>
            ))}
          </select>
        </label>
      </div>

      {activeDims.length > 0 && (
        <ul className="mp-sales-chips" aria-label={t("activeFilters")}>
          {activeDims.map((d) => (
            <li key={d}>
              <button type="button" className="mp-sales-chip" onClick={() => go(withoutDimension(filters, d))} aria-label={t("removeFilter", { filter: dimName(d, t), value: dimValueLabel(d, filters.dims[d] as never, labelCtx) })}>
                <span className="text-op-muted">{dimName(d, t)}</span>
                <span>{dimValueLabel(d, filters.dims[d] as never, labelCtx)}</span>
                <span aria-hidden="true">{"×"}</span>
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className="mp-sales-clear"
              onClick={() => go(DIMENSIONS.reduce((acc, d) => withoutDimension(acc, d), filters))}
            >
              {t("clearFilters")}
            </button>
          </li>
        </ul>
      )}
    </section>
  );
}
