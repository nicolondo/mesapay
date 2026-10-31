// Cuentas del día (el último escalón del drill-down): cada una enlaza a su
// detalle en Órdenes. Respeta los filtros activos (mesero, canal, hora…).
import Link from "next/link";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { displayOrderCode } from "@/lib/orderCode";
import type { OrderListRow } from "@/lib/salesAnalysis/types";
import { channelLabel, methodLabel, tableName } from "@/lib/salesAnalysis/dimLabels";
import { fmtNumber } from "@/lib/salesAnalysis/labels";
import type { Tr } from "@/lib/salesAnalysis/dimLabels";

export function OrdersPanel({
  t,
  orders,
  truncated,
  currency,
  locale,
  counterMode,
  itemFilter,
}: {
  t: Tr;
  orders: OrderListRow[];
  truncated: boolean;
  currency: string;
  locale: Locale;
  counterMode: boolean;
  itemFilter: boolean;
}) {
  const money = (v: number | null) => (v === null ? t("notApplicable") : formatMoney(v, { currency, locale }));
  return (
    <section className="mp-panel mp-sales-panel" aria-labelledby="sales-orders-title">
      <div className="mp-panel-heading">
        <div>
          <h2 id="sales-orders-title">{t("orders.title")}</h2>
          <p className="mp-sales-sub">{itemFilter ? t("orders.itemFilterNote") : t("orders.subtitle", { count: orders.length })}</p>
        </div>
      </div>
      <div className="mp-sales-panel-body">
        {orders.length === 0 ? (
          <div className="mp-viz-empty">{t("emptyPeriod")}</div>
        ) : (
          <div className="mp-sales-table-wrap">
            <table className="mp-sales-table">
              <thead>
                <tr>
                  <th scope="col">{t("orders.paidAt")}</th>
                  <th scope="col">{t("orders.account")}</th>
                  <th scope="col">{t("orders.where")}</th>
                  <th scope="col">{t("team.waiter")}</th>
                  <th scope="col" className="num">{t("kpi.diners")}</th>
                  <th scope="col" className="num">{t("units")}</th>
                  <th scope="col" className="num">{t("kpi.net")}</th>
                  <th scope="col" className="num">{t("kpi.tips")}</th>
                  <th scope="col" className="num">{t("orders.collected")}</th>
                  <th scope="col">{t("dim.pago")}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="num-left">
                      <time dateTime={o.paidAt.toISOString()}>
                        {formatDate(o.paidAt, { locale, dateStyle: undefined, timeStyle: undefined, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}
                      </time>
                    </td>
                    <th scope="row">
                      <Link prefetch={false} href={`/operator/orders/${o.id}`} className="mp-sales-name-link" title={o.shortCode}>
                        {displayOrderCode(o.shortCode)}
                      </Link>
                    </th>
                    <td>{o.channel === "salon" && !counterMode ? tableName({ number: o.tableNumber, label: o.tableLabel }, t) : channelLabel(o.channel, t, counterMode)}</td>
                    <td>{o.waiterName ?? t("noWaiter")}</td>
                    <td className="num">{fmtNumber(o.diners, locale)}</td>
                    <td className="num">{fmtNumber(o.units, locale)}</td>
                    <td className="num">{money(o.netCents)}</td>
                    <td className="num">{money(o.tipCents)}</td>
                    <td className="num">{money(o.totalCents)}</td>
                    <td>{o.methods.map((m) => methodLabel(m, t)).join(", ") || t("emptyDash")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {truncated && <p className="mp-sales-note">{t("orders.truncated", { count: orders.length })}</p>}
      </div>
    </section>
  );
}
