"use client";

// Productos y categorías: top y bottom por venta y por cantidad, con su
// participación, precio neto promedio, variación y (si hay costo confiable)
// margen. Clic en un producto o en una categoría = filtrar todo por él.
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { BarList, type BarItem } from "@/components/charts/BarList";
import { ChartLink } from "@/components/charts/ChartNav";
import { formatValue } from "@/components/charts/format";
import { defaultLocale, isLocale } from "@/i18n/config";
import { salesHref, withDimension, type SalesFilters } from "@/lib/salesAnalysis/filters";
import { deltaTone, share, variation } from "@/lib/salesAnalysis/compare";
import type { CategoryRow, ModifierRow, ProductRow } from "@/lib/salesAnalysis/types";
import { categoryName } from "@/lib/salesAnalysis/dimLabels";
import { fmtDelta, fmtPercent } from "@/lib/salesAnalysis/labels";

type Sort = "topNet" | "topUnits" | "bottomNet" | "bottomUnits";
const PAGE = 15;

export function ProductsPanel({
  products,
  compareProducts,
  categories,
  compareCategories,
  modifiers,
  unsold,
  margins,
  categoryLabels,
  filters,
  currency,
}: {
  products: ProductRow[];
  compareProducts: ProductRow[] | null;
  categories: CategoryRow[];
  compareCategories: CategoryRow[] | null;
  modifiers: ModifierRow[];
  unsold: { id: string; name: string }[];
  /** Margen unitario por plato con costo confiable (null = sin ingeniería). */
  margins: Record<string, { unitMarginCents: number; marginPct: number }> | null;
  categoryLabels: Record<string, string>;
  filters: SalesFilters;
  currency: string;
}) {
  const t = useTranslations("salesAnalysis");
  const localeValue = useLocale();
  const locale = isLocale(localeValue) ? localeValue : defaultLocale;
  const [sort, setSort] = useState<Sort>("topNet");
  const [all, setAll] = useState(false);
  const money = { kind: "money" as const, currency, locale };
  const count = { kind: "number" as const, locale };
  const totalNet = products.reduce((s, p) => s + p.netCents, 0);
  const prevByKey = new Map((compareProducts ?? []).map((p) => [p.key, p]));

  const sorted = [...products].sort((a, b) => {
    switch (sort) {
      case "topNet":
        return b.netCents - a.netCents || b.units - a.units;
      case "topUnits":
        return b.units - a.units || b.netCents - a.netCents;
      case "bottomNet":
        return a.netCents - b.netCents || a.units - b.units;
      case "bottomUnits":
        return a.units - b.units || a.netCents - b.netCents;
    }
  });
  const shown = all ? sorted : sorted.slice(0, PAGE);
  const byUnits = sort === "topUnits" || sort === "bottomUnits";
  const maxValue = Math.max(0, ...products.map((p) => (byUnits ? p.units : p.netCents)));

  const totalCatNet = categories.reduce((s, c) => s + c.netCents, 0);
  const prevCat = new Map((compareCategories ?? []).map((c) => [c.categoryId ?? "", c]));
  const catItems: BarItem[] = categories.map((c) => {
    const d = compareCategories ? variation(c.netCents, prevCat.get(c.categoryId ?? "")?.netCents ?? null) : null;
    const name = categoryName(c, t);
    const pct = share(c.netCents, totalCatNet);
    return {
      key: c.categoryId ?? "free",
      label: name,
      value: c.netCents,
      valueLabel: formatValue(c.netCents, money),
      sub: t("products.categorySub", { share: pct === null ? t("emptyDash") : fmtPercent(pct, locale), units: c.units }),
      delta: d === null ? null : { text: fmtDelta(d, locale), tone: deltaTone(d, "up") },
      href: c.categoryId ? salesHref(withDimension(filters, "categoria", c.categoryId)) : undefined,
      selected: c.categoryId !== null && c.categoryId === filters.dims.categoria,
      tooltip: {
        title: name,
        rows: [
          { value: formatValue(c.netCents, money), label: t("kpi.net") },
          { value: formatValue(c.units, count), label: t("units") },
          { value: formatValue(c.orders, count), label: t("kpi.orders") },
        ],
        hint: c.categoryId ? t("clickToFilter") : undefined,
      },
    };
  });

  return (
    <section className="mp-panel mp-sa-panel" aria-labelledby="sales-products-title">
      <div className="mp-panel-heading">
        <div>
          <h2 id="sales-products-title">{t("products.title")}</h2>
          <p className="mp-sales-sub">{t("products.subtitle", { count: products.length })}</p>
        </div>
        <div className="mp-seg mp-sales-seg-scroll" role="radiogroup" aria-label={t("products.sortLabel")}>
          {(["topNet", "topUnits", "bottomNet", "bottomUnits"] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={sort === s} data-active={sort === s || undefined} className="mp-seg__i" onClick={() => setSort(s)}>
              {t(`products.sort.${s}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="mp-sales-panel-body">
        {products.length === 0 ? (
          <div className="mp-viz-empty">{t("emptyPeriod")}</div>
        ) : (
          <div className="mp-sales-table-wrap">
            <table className="mp-sales-table mp-sales-products">
              <thead>
                <tr>
                  <th scope="col" className="rank">{"#"}</th>
                  <th scope="col">{t("products.product")}</th>
                  <th scope="col" className="bar"><span className="sr-only">{byUnits ? t("units") : t("kpi.net")}</span></th>
                  <th scope="col" className="num">{t("units")}</th>
                  <th scope="col" className="num">{t("kpi.net")}</th>
                  <th scope="col" className="num">{t("products.share")}</th>
                  <th scope="col" className="num">{t("products.avgPrice")}</th>
                  {compareProducts && <th scope="col" className="num">{t("variation")}</th>}
                  {margins && <th scope="col" className="num">{t("products.unitMargin")}</th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((p, i) => {
                  const prev = prevByKey.get(p.key);
                  const d = compareProducts ? variation(p.netCents, prev?.netCents ?? null) : null;
                  const pct = share(p.netCents, totalNet);
                  const value = byUnits ? p.units : p.netCents;
                  const margin = p.menuItemId && margins ? margins[p.menuItemId] : undefined;
                  return (
                    <tr key={p.key} data-selected={p.menuItemId === filters.dims.producto || undefined}>
                      <td className="rank">{i + 1}</td>
                      <th scope="row">
                        {p.menuItemId ? (
                          <ChartLink href={salesHref(withDimension(filters, "producto", p.menuItemId))} className="mp-sales-name-link">{p.name}</ChartLink>
                        ) : (
                          <span>{p.name}</span>
                        )}
                        <span className="mp-sales-cell-sub">
                          {p.categoryId ? categoryLabels[p.categoryId] ?? t("unknownValue") : t("freeLines")}
                        </span>
                      </th>
                      <td className="bar" aria-hidden="true">
                        <span className="mp-viz-bar-track">
                          <span className="mp-viz-bar" style={{ width: `${maxValue > 0 ? Math.max(value > 0 ? 2 : 0, (value / maxValue) * 100) : 0}%` }} />
                        </span>
                      </td>
                      <td className="num">{formatValue(p.units, count)}</td>
                      <td className="num">{formatValue(p.netCents, money)}</td>
                      <td className="num">{pct === null ? t("emptyDash") : fmtPercent(pct, locale)}</td>
                      <td className="num">{p.units > 0 ? formatValue(Math.round(p.netCents / p.units), money) : t("emptyDash")}</td>
                      {compareProducts && (
                        <td className="num">
                          {d === null ? (
                            <span className="text-op-muted">{prev ? t("emptyDash") : t("products.new")}</span>
                          ) : (
                            <span className={`mp-viz-delta--${deltaTone(d, "up")}`}>{fmtDelta(d, locale)}</span>
                          )}
                        </td>
                      )}
                      {margins && (
                        <td className="num">
                          {margin ? `${formatValue(Math.round(margin.unitMarginCents), money)} · ${fmtPercent(margin.marginPct, locale)}` : t("emptyDash")}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {sorted.length > PAGE && (
          <button type="button" className="mp-text-link mp-sales-more-link" onClick={() => setAll(!all)}>
            {all ? t("showLess") : t("showAll", { count: sorted.length })}
          </button>
        )}
      </div>

      <div className="mp-sales-split">
        <div>
          <h3 className="mp-sales-h3">{t("products.categories")}</h3>
          <BarList items={catItems} ariaLabel={t("products.categories")} empty={t("emptyPeriod")} />
        </div>
        <div>
          <h3 className="mp-sales-h3">{t("products.modifiers")}</h3>
          {modifiers.length === 0 ? (
            <div className="mp-viz-empty">{t("products.noModifiers")}</div>
          ) : (
            <BarList
              ariaLabel={t("products.modifiers")}
              items={modifiers.map((m) => ({
                key: `${m.group ?? ""}:${m.option}`,
                label: m.option,
                value: m.units,
                valueLabel: t("unitsCount", { count: m.units }),
                sub: m.group ?? t("products.modifierNoGroup"),
              }))}
            />
          )}
          {unsold.length > 0 && (
            <details className="mp-sales-unsold">
              <summary>{t("products.unsold", { count: unsold.length })}</summary>
              <ul>
                {unsold.slice(0, 60).map((u) => (
                  <li key={u.id}>{u.name}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
