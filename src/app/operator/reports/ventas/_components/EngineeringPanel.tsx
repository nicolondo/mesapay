"use client";

// Ingeniería de menú en lenguaje simple: cada plato con costo confiable se
// ubica por popularidad (unidades) y margen unitario (precio neto real −
// costo actual de la receta). Si el costo no es confiable, se explica qué
// falta en vez de inventar un margen.
import { useLocale, useTranslations } from "next-intl";
import { QuadrantScatter } from "@/components/charts/QuadrantScatter";
import { ChartLink } from "@/components/charts/ChartNav";
import { formatValue } from "@/components/charts/format";
import { defaultLocale, isLocale } from "@/i18n/config";
import type { Quadrant } from "@/lib/erp/recipes";
import { salesHref, withDimension, type SalesFilters } from "@/lib/salesAnalysis/filters";
import { LOW_COVERAGE, type MenuEngineering } from "@/lib/salesAnalysis/menuEngineering";
import { fmtPercent } from "@/lib/salesAnalysis/labels";

const QUADRANTS: Quadrant[] = ["star", "plowhorse", "puzzle", "dog"];

export function EngineeringPanel({
  engineering,
  filters,
  currency,
}: {
  engineering: MenuEngineering;
  filters: SalesFilters;
  currency: string;
}) {
  const t = useTranslations("salesAnalysis");
  const localeValue = useLocale();
  const locale = isLocale(localeValue) ? localeValue : defaultLocale;
  const money = { kind: "money" as const, currency, locale };
  const count = { kind: "number" as const, locale };
  const e = engineering;
  const reasons = e.unreliable.reduce<Record<string, number>>((acc, u) => ({ ...acc, [u.reason]: (acc[u.reason] ?? 0) + 1 }), {});

  return (
    <section className="mp-panel mp-sa-panel" aria-labelledby="sales-eng-title">
      <div className="mp-panel-heading">
        <div>
          <h2 id="sales-eng-title">{t("eng.title")}</h2>
          <p className="mp-sales-sub">{t("eng.subtitle")}</p>
        </div>
        <span className="mp-sales-badge">{t("eng.coverage", { pct: fmtPercent(e.coverage, locale) })}</span>
      </div>
      <div className="mp-sales-panel-body">
        {!e.enough ? (
          <div className="mp-sales-callout" role="note">
            <p className="font-medium">{t("eng.notEnoughTitle")}</p>
            <p>{t("eng.notEnoughBody", { count: e.dishes.length })}</p>
            <ul className="mp-sales-reasons">
              {(["no_recipe", "incomplete_cost", "zero_cost"] as const).filter((r) => reasons[r]).map((r) => (
                <li key={r}>{t(`eng.reason.${r}`, { count: reasons[r]! })}</li>
              ))}
            </ul>
            <ChartLink href="/operator/recetas" className="mp-text-link">{t("eng.goRecipes")}</ChartLink>
          </div>
        ) : (
          <>
            {e.coverage < LOW_COVERAGE && (
              <p className="mp-sales-callout" role="note">{t("eng.lowCoverage", { pct: fmtPercent(e.coverage, locale) })}</p>
            )}
            <QuadrantScatter
              points={e.dishes.map((d) => ({
                key: d.menuItemId,
                x: d.units,
                y: d.unitMarginCents,
                ariaLabel: t("eng.pointAria", {
                  name: d.name,
                  quadrant: t(`eng.q.${d.quadrant}.name`),
                  units: d.units,
                  margin: formatValue(Math.round(d.unitMarginCents), money),
                }),
                tooltip: {
                  title: d.name,
                  rows: [
                    { value: t(`eng.q.${d.quadrant}.name`), label: t("eng.quadrant") },
                    { value: formatValue(d.units, count), label: t("units") },
                    { value: formatValue(Math.round(d.unitNetCents), money), label: t("products.avgPrice") },
                    { value: formatValue(Math.round(d.unitCostCents), money), label: t("eng.unitCost") },
                    { value: `${formatValue(Math.round(d.unitMarginCents), money)} · ${fmtPercent(d.marginPct, locale)}`, label: t("products.unitMargin") },
                  ],
                  hint: t("clickToFilter"),
                },
                href: salesHref(withDimension(filters, "producto", d.menuItemId)),
              }))}
              xThreshold={e.popularityThreshold}
              yThreshold={e.marginThreshold}
              xFormat={count}
              yFormat={money}
              xLabel={t("eng.xLabel")}
              yLabel={t("eng.yLabel")}
              quadrants={{
                topRight: t("eng.q.star.name"),
                bottomRight: t("eng.q.plowhorse.name"),
                topLeft: t("eng.q.puzzle.name"),
                bottomLeft: t("eng.q.dog.name"),
              }}
              ariaLabel={t("eng.aria")}
            />
            <div className="mp-sales-quadrants">
              {QUADRANTS.map((q) => {
                const dishes = e.dishes.filter((d) => d.quadrant === q);
                return (
                  <div key={q} className="mp-sales-quadrant">
                    <h3 className="mp-sales-h3">{t(`eng.q.${q}.name`)} <span className="text-op-muted">({dishes.length})</span></h3>
                    <p className="mp-sales-sub">{t(`eng.q.${q}.meaning`)}</p>
                    <p className="mp-sales-action">{t(`eng.q.${q}.action`)}</p>
                    {dishes.length > 0 && (
                      <ul>
                        {dishes.slice(0, 8).map((d) => (
                          <li key={d.menuItemId}>
                            <ChartLink href={salesHref(withDimension(filters, "producto", d.menuItemId))} className="mp-sales-name-link">{d.name}</ChartLink>
                          </li>
                        ))}
                        {dishes.length > 8 && <li className="text-op-muted">{t("andMore", { count: dishes.length - 8 })}</li>}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
        <p className="mp-sales-note">{t("eng.caveat")}</p>
      </div>
    </section>
  );
}
