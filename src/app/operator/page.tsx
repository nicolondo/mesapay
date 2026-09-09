import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { LiveRefresh } from "./LiveRefresh";
import { CashBox } from "@/components/CashBox";
import { buildCashSnapshot } from "@/lib/cashBox";
import { resolveShiftPolicy } from "@/lib/staffPolicies";
import { bogotaBusinessTodayIso, bogotaDayRange } from "@/lib/bogota";

export const dynamic = "force-dynamic";

export default async function OperatorHome() {
  const tr = await getTranslations("opDashboard");
  const ux = await getTranslations("workspaceUi");
  const locale = await getLocale();
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return (
      <div className="p-8">
        <p>{tr("noRestaurant")}</p>
      </div>
    );
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      name: true,
      slug: true,
      serviceMode: true,
      shiftPolicy: true,
      businessDayCutoffHour: true,
    },
  });
  const counterMode = tenant?.serviceMode === "counter";
  // Snapshot inicial de caja (el CashBox refresca en vivo por SSE).
  const cashSnap = await buildCashSnapshot(
    restaurantId,
    resolveShiftPolicy(tenant?.shiftPolicy),
  );

  // "Hoy" = día contable del comercio (hora de corte configurable, ej. 5am):
  // un cobro a las 2am cuenta para la jornada que arrancó la tarde anterior,
  // no para el nuevo día calendario.
  const cutoff = tenant?.businessDayCutoffHour ?? 0;
  const today = bogotaDayRange(bogotaBusinessTodayIso(cutoff), cutoff).start;

  // Inicio de la ventana de 7 jornadas (incluye hoy): hoy − 6 días.
  const weekStart = new Date(today.getTime() - 6 * 86400000);

  const [
    openOrdersCount,
    todayPaidCount,
    todayPaidAgg,
    weekPaid,
    topItemsRaw,
    openOrders,
  ] = await Promise.all([
    db.order.count({
      where: {
        restaurantId,
        status: { in: ["placed", "in_kitchen", "ready", "served", "paying"] },
      },
    }),
    db.order.count({
      where: { restaurantId, status: "paid", paidAt: { gte: today } },
    }),
    db.order.aggregate({
      where: { restaurantId, status: "paid", paidAt: { gte: today } },
      _sum: { totalCents: true },
      _avg: { totalCents: true },
    }),
    db.order.findMany({
      where: {
        restaurantId,
        status: "paid",
        paidAt: { gte: weekStart },
      },
      select: { totalCents: true, paidAt: true },
    }),
    db.orderItem.groupBy({
      by: ["nameSnapshot"],
      where: {
        order: { restaurantId, status: "paid", paidAt: { gte: today } },
        cancelledAt: null,
        OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
      },
      _sum: { qty: true },
      orderBy: { _sum: { qty: "desc" } },
      take: 5,
    }),
    db.order.findMany({
      where: {
        restaurantId,
        status: { in: ["placed", "in_kitchen", "ready", "served", "paying"] },
      },
      orderBy: { createdAt: "asc" },
      take: 10,
      include: {
        table: true,
        items: {
          where: {
            cancelledAt: null,
            OR: [
              { roundId: null },
              { round: { status: { not: "cancelled" } } },
            ],
          },
        },
      },
    }),
  ]);

  const avgTicketCents = Math.round(todayPaidAgg._avg.totalCents ?? 0);
  const salesTodayCents = todayPaidAgg._sum.totalCents ?? 0;

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return { date: d, cents: 0 };
  });
  for (const p of weekPaid) {
    if (!p.paidAt) continue;
    const idx = Math.floor(
      (new Date(p.paidAt).getTime() - weekStart.getTime()) / 86400000,
    );
    if (idx >= 0 && idx < 7) weekDays[idx].cents += p.totalCents;
  }
  const maxDay = Math.max(1, ...weekDays.map((d) => d.cents));

  return (
    <div className="mp-page">
      {tenant?.slug && <LiveRefresh tenantSlug={tenant.slug} />}
      <header className="mp-page-header">
        <div>
          <p className="mp-eyebrow">{tenant?.name}</p>
          <h1 className="mp-page-title">{ux("overviewTitle")}</h1>
          <p className="mp-page-description">{ux("overviewDescription")}</p>
        </div>
        <Link href="/operator/tables" className="mp-btn mp-btn--primary">
          <Icon name="tables" />
          {ux("viewService")}
          <Icon name="arrow" width="16" />
        </Link>
      </header>
      <div className="mp-kpis">
        <Kpi
          label={tr("kpiSalesToday")}
          value={fmtCOP(salesTodayCents)}
          href="/operator/payments"
          primary
        />
        <Kpi
          label={tr("kpiPaidOrders")}
          value={String(todayPaidCount)}
          href="/operator/orders?status=paid"
        />
        <Kpi
          label={tr("kpiAvgTicket")}
          value={todayPaidCount === 0 ? tr("dash") : fmtCOP(avgTicketCents)}
          href="/operator/reports"
        />
        <Kpi
          label={tr("kpiOpenNow")}
          value={String(openOrdersCount)}
          href="/operator/tables"
          accent={openOrdersCount > 0}
        />
      </div>
      <div className="mt-5">
        <CashBox
          initial={cashSnap}
          snapshotUrl="/api/operator/cash/snapshot"
          movementUrl="/api/operator/cash/movement"
          baseUrl="/api/operator/shifts/base"
          tenantSlug={tenant?.slug ?? ""}
        />
      </div>
      <div className="mp-dashboard-columns">
        <section className="mp-panel" aria-labelledby="sales-title">
          <div className="mp-panel-heading">
            <h2 id="sales-title">{tr("last7Days")}</h2>
            <span className="text-sm font-medium tabular">
              {fmtCOP(weekDays.reduce((sum, d) => sum + d.cents, 0))}
            </span>
          </div>
          <div className="mp-sales-chart" aria-hidden="true">
            {weekDays.map((d, i) => (
              <div key={i} className="mp-sales-column">
                <span className="mp-sales-value">{fmtCOP(d.cents)}</span>
                <div className="mp-sales-track">
                  <div
                    className={"mp-sales-bar" + (i === 6 ? " is-today" : "")}
                    style={{
                      height: `${d.cents === 0 ? 0 : Math.max(3, Math.round((d.cents / maxDay) * 100))}%`,
                    }}
                  />
                </div>
                <span className="mp-sales-day">{dayLabel(d.date, tr)}</span>
              </div>
            ))}
          </div>
          <details className="mp-chart-details">
            <summary>{ux("dailyBreakdown")}</summary>
            <table className="w-full text-sm">
              <caption className="sr-only">{tr("last7Days")}</caption>
              <tbody>
                {weekDays.map((d, i) => (
                  <tr key={i}>
                    <th scope="row" className="text-left font-normal py-2">
                      {d.date.toLocaleDateString(locale, {
                        timeZone: "America/Bogota",
                        day: "numeric",
                        month: "short",
                      })}
                    </th>
                    <td className="text-right tabular">{fmtCOP(d.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
        <section className="mp-panel" aria-labelledby="top-dishes-title">
          <div className="mp-panel-heading">
            <h2 id="top-dishes-title">{tr("topDishesToday")}</h2>
            <Link href="/operator/menu" className="mp-text-link">
              {tr("viewMenu")}
            </Link>
          </div>
          <ol className="mp-ranking">
            {topItemsRaw.map((item, i) => (
              <li key={item.nameSnapshot}>
                <span className="mp-rank-number">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex-1 min-w-0 text-sm font-medium">
                  {item.nameSnapshot}
                </span>
                <span className="text-sm tabular text-op-muted">
                  {tr("itemCount", { count: item._sum.qty ?? 0 })}
                </span>
              </li>
            ))}
          </ol>
          {topItemsRaw.length === 0 && (
            <div className="mp-empty-state">
              <Icon name="menu" />
              <p>{tr("noPaidYet")}</p>
              <Link href="/operator/menu" className="mp-text-link">
                {tr("viewMenu")}
              </Link>
            </div>
          )}
        </section>
      </div>
      <section
        className="mp-panel mp-active-orders"
        aria-labelledby="active-orders-title"
      >
        <div className="mp-panel-heading">
          <h2 id="active-orders-title">
            {counterMode ? tr("activeOrders") : tr("activeTables")}
            <span className="mp-count">{openOrdersCount}</span>
          </h2>
          <Link href="/operator/kitchen" className="mp-text-link">
            {tr("goToKitchen")}
          </Link>
        </div>
        <ul>
          {openOrders.map((o) => (
            <li key={o.id}>
              <Link href={`/operator/orders/${o.id}`} className="mp-order-row">
                <span className="mp-table-number">
                  {counterMode ? <Icon name="orders" /> : o.table.number}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold">
                    {counterMode
                      ? o.shortCode
                      : tr("tableLabel", { number: o.table.number })}
                  </span>
                  <span className="block text-xs text-op-muted mt-1">
                    {o.shortCode} ·{" "}
                    {tr("itemCount", {
                      count: o.items.reduce((sum, item) => sum + item.qty, 0),
                    })}{" "}
                    · {ageLabel(o.createdAt, tr)}
                  </span>
                </span>
                <span className={`mp-order-status status-${o.status}`}>
                  {statusLabel(o.status, tr)}
                </span>
                <span className="mp-order-amount">{fmtCOP(o.totalCents)}</span>
                <Icon
                  name="arrow"
                  className="hidden sm:block text-op-muted"
                  width="16"
                />
              </Link>
            </li>
          ))}
        </ul>
        {openOrders.length === 0 && (
          <div className="mp-empty-state">
            <Icon name="tables" />
            <p>{counterMode ? tr("noActiveOrders") : tr("noActiveTables")}</p>
            <Link href="/operator/tables" className="mp-btn mp-btn--secondary">
              {ux("viewService")}
            </Link>
          </div>
        )}
        {openOrdersCount > openOrders.length && (
          <Link href="/operator/tables" className="mp-panel-footer">
            {ux("viewAllActive", { count: openOrdersCount })}
            <Icon name="arrow" width="16" />
          </Link>
        )}
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  href,
  accent,
  primary,
}: {
  label: string;
  value: string;
  href: string;
  accent?: boolean;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`mp-kpi${primary ? " mp-kpi--primary" : ""}${accent ? " mp-kpi--accent" : ""}`}
    >
      <span className="mp-kpi-label">
        {label}
        <Icon name="arrow" width="16" />
      </span>
      <span className="mp-kpi-value">{value}</span>
    </Link>
  );
}

type Tr = (key: string, values?: Record<string, string | number>) => string;

const DAY_KEYS = [
  "daySun",
  "dayMon",
  "dayTue",
  "dayWed",
  "dayThu",
  "dayFri",
  "daySat",
];
function dayLabel(d: Date, tr: Tr) {
  return tr(DAY_KEYS[d.getUTCDay()]);
}

function statusLabel(s: string, tr: Tr) {
  switch (s) {
    case "open":
      return tr("statusOpen");
    case "placed":
      return tr("statusPlaced");
    case "in_kitchen":
      return tr("statusInKitchen");
    case "ready":
      return tr("statusReady");
    case "served":
      return tr("statusServed");
    case "paying":
      return tr("statusPaying");
    default:
      return s;
  }
}

function ageLabel(d: Date, tr: Tr) {
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return tr("ageNow");
  if (mins < 60) return tr("ageMinutes", { mins });
  const h = Math.floor(mins / 60);
  return tr("ageHours", { hours: h });
}
