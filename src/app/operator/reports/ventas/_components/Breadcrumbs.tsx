// Migas del drill-down: raíz › período de origen › período › cada filtro en
// el orden en que se aplicó. Cada paso vuelve al estado sin lo que siguió.
import { ChartLink } from "@/components/charts/ChartNav";
import type { Locale } from "@/i18n/config";
import { backToOrigin, breadcrumbs, type DimensionFilters, type SalesFilters } from "@/lib/salesAnalysis/filters";
import type { FilterOptions } from "@/lib/salesAnalysis/types";
import { dimName, dimValueLabel, periodLabel } from "@/lib/salesAnalysis/dimLabels";
import type { Tr } from "@/lib/salesAnalysis/dimLabels";

export function Breadcrumbs({
  t,
  filters,
  options,
  locale,
  counterMode,
}: {
  t: Tr;
  filters: SalesFilters;
  options: FilterOptions;
  locale: Locale;
  counterMode: boolean;
}) {
  const crumbs = breadcrumbs(filters);
  if (crumbs.length <= 2) return null;
  const origin = backToOrigin({ ...filters, dims: {}, dimOrder: [] });
  const ctx = { t, locale, options, counterMode };
  const dims = filters.dimOrder.filter((d) => filters.dims[d] !== undefined);
  // Rótulos en el orden de las migas: raíz, [origen], período, filtros.
  const labels = [
    t("title"),
    ...(origin ? [periodLabel(origin, t, locale)] : []),
    periodLabel(filters, t, locale),
    ...dims.map((d) => `${dimName(d, t)}: ${dimValueLabel(d, filters.dims[d] as NonNullable<DimensionFilters[typeof d]>, ctx)}`),
  ];
  return (
    <nav aria-label={t("breadcrumbs")} className="mp-sales-crumbs">
      <ol>
        {crumbs.map((c, i) => {
          const label = labels[i] ?? "";
          return (
            <li key={`${c.kind}-${i}`}>
              {c.current ? (
                <span aria-current="page">{label}</span>
              ) : (
                <ChartLink href={c.href}>{label}</ChartLink>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
