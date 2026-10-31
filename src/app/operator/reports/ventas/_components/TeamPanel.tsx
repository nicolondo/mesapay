// Equipo: por mesero, venta neta, cuentas, ticket promedio, comensales,
// propinas y comisión sellada. El mesero de la cuenta es el de su comisión
// sellada; si no la tiene, el mesero que montó más valor de la cuenta.
import { ChartLink } from "@/components/charts/ChartNav";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { NO_WAITER, salesHref, withDimension, type SalesFilters } from "@/lib/salesAnalysis/filters";
import { deltaTone, variation } from "@/lib/salesAnalysis/compare";
import type { WaiterRow } from "@/lib/salesAnalysis/types";
import { fmtDelta, fmtNumber } from "@/lib/salesAnalysis/labels";
import type { Tr } from "@/lib/salesAnalysis/dimLabels";

export function TeamPanel({
  t,
  waiters,
  compareWaiters,
  filters,
  currency,
  locale,
}: {
  t: Tr;
  waiters: WaiterRow[];
  compareWaiters: WaiterRow[] | null;
  filters: SalesFilters;
  currency: string;
  locale: Locale;
}) {
  const money = (v: number | null) => (v === null ? t("notApplicable") : formatMoney(v, { currency, locale }));
  const max = Math.max(0, ...waiters.map((w) => w.netCents));
  const prev = new Map((compareWaiters ?? []).map((w) => [w.waiterId ?? NO_WAITER, w]));
  return (
    <section className="mp-panel mp-sales-panel" aria-labelledby="sales-team-title">
      <div className="mp-panel-heading">
        <div>
          <h2 id="sales-team-title">{t("team.title")}</h2>
          <p className="mp-sales-sub">{t("team.subtitle")}</p>
        </div>
      </div>
      <div className="mp-sales-panel-body">
        {waiters.length === 0 ? (
          <div className="mp-viz-empty">{t("emptyPeriod")}</div>
        ) : (
          <div className="mp-sales-table-wrap">
            <table className="mp-sales-table">
              <thead>
                <tr>
                  <th scope="col">{t("team.waiter")}</th>
                  <th scope="col" className="bar"><span className="sr-only">{t("kpi.net")}</span></th>
                  <th scope="col" className="num">{t("kpi.net")}</th>
                  <th scope="col" className="num">{t("kpi.orders")}</th>
                  <th scope="col" className="num">{t("kpi.avgTicket")}</th>
                  <th scope="col" className="num">{t("kpi.diners")}</th>
                  <th scope="col" className="num">{t("kpi.tips")}</th>
                  <th scope="col" className="num">{t("team.commission")}</th>
                  {compareWaiters && <th scope="col" className="num">{t("variation")}</th>}
                </tr>
              </thead>
              <tbody>
                {waiters.map((w) => {
                  const key = w.waiterId ?? NO_WAITER;
                  const name = w.waiterId ? w.name ?? t("unknownValue") : t("noWaiter");
                  const d = compareWaiters ? variation(w.netCents, prev.get(key)?.netCents ?? null) : null;
                  return (
                    <tr key={key} data-selected={filters.dims.mesero === key || undefined}>
                      <th scope="row">
                        <ChartLink href={salesHref(withDimension(filters, "mesero", key))} className="mp-sales-name-link">{name}</ChartLink>
                      </th>
                      <td className="bar" aria-hidden="true">
                        <span className="mp-viz-bar-track">
                          <span className="mp-viz-bar" style={{ width: `${max > 0 ? Math.max(w.netCents > 0 ? 2 : 0, (w.netCents / max) * 100) : 0}%` }} />
                        </span>
                      </td>
                      <td className="num">{money(w.netCents)}</td>
                      <td className="num">{fmtNumber(w.orders, locale)}</td>
                      <td className="num">{w.orders > 0 ? money(Math.round(w.netCents / w.orders)) : t("emptyDash")}</td>
                      <td className="num">{fmtNumber(w.diners, locale)}</td>
                      <td className="num">{money(w.tipCents)}</td>
                      <td className="num">{w.commissionCents === null ? t("emptyDash") : money(w.commissionCents)}</td>
                      {compareWaiters && (
                        <td className="num">
                          {d === null ? t("emptyDash") : <span className={`mp-viz-delta--${deltaTone(d, "up")}`}>{fmtDelta(d, locale)}</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mp-sales-note">{t("team.note")}</p>
      </div>
    </section>
  );
}
