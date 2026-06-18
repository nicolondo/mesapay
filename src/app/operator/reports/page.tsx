import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { addDaysIso, bogotaDayRange, bogotaBusinessTodayIso, fmtBogotaDateTime } from "@/lib/bogota";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  computeOpenShiftMetrics,
  getCurrentShift,
  getRecentShifts,
  listOpenOrders,
} from "@/lib/shift";
import { ShiftPanel } from "./ShiftPanel";
import { CashBox } from "@/components/CashBox";
import { buildCashSnapshot } from "@/lib/cashBox";
import { resolveShiftPolicy } from "@/lib/staffPolicies";

export const dynamic = "force-dynamic";

const METHOD_KEY: Record<string, string> = {
  demo_card: "methodDemoCard",
  demo_cash: "methodDemoCash",
  wompi_card: "methodWompiCard",
  wompi_pse: "methodWompiPse",
  wompi_nequi: "methodWompiNequi",
  kushki_apple_pay: "methodKushkiApplePay",
  kushki_card_terminal: "methodKushkiCardTerminal",
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const t = await getTranslations("opReports");
  const methodLabel = (method: string) =>
    METHOD_KEY[method] ? t(METHOD_KEY[method]) : method;
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const sp = await searchParams;
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      serviceMode: true,
      shiftPolicy: true,
      slug: true,
      businessDayCutoffHour: true,
    },
  });
  const counterMode = tenant?.serviceMode === "counter";
  // Día contable: arranca a la hora de corte del comercio (ej. 5am)
  // para que la noche de trabajo no se parta en medianoche.
  const cutoff = tenant?.businessDayCutoffHour ?? 0;
  const dateIso = validIso(sp.date) ?? bogotaBusinessTodayIso(cutoff);
  const { start, end } = bogotaDayRange(dateIso, cutoff);
  const todayIso = bogotaBusinessTodayIso(cutoff);
  const prevDay = addDaysIso(dateIso, -1);
  const nextDay = addDaysIso(dateIso, 1);
  const isToday = dateIso === todayIso;
  // Snapshot inicial de caja — el CashBox refresca en vivo por SSE.
  const cashSnap = await buildCashSnapshot(
    restaurantId,
    resolveShiftPolicy(tenant?.shiftPolicy),
  );

  const payments = await db.payment.findMany({
    where: {
      status: "approved",
      createdAt: { gte: start, lt: end },
      order: { restaurantId },
    },
    include: {
      order: {
        select: {
          shortCode: true,
          tipCents: true,
          subtotalCents: true,
          totalCents: true,
          paidAt: true,
          table: { select: { number: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const paidOrders = await db.order.findMany({
    where: {
      restaurantId,
      status: "paid",
      paidAt: { gte: start, lt: end },
    },
    select: { id: true, subtotalCents: true, tipCents: true, totalCents: true },
  });

  const byMethod = new Map<string, { count: number; sum: number }>();
  for (const p of payments) {
    const m = byMethod.get(p.method) ?? { count: 0, sum: 0 };
    m.count += 1;
    m.sum += p.amountCents;
    byMethod.set(p.method, m);
  }
  const paymentsTotal = payments.reduce((s, p) => s + p.amountCents, 0);
  const tipsTotal = paidOrders.reduce((s, o) => s + o.tipCents, 0);
  const subtotalTotal = paidOrders.reduce((s, o) => s + o.subtotalCents, 0);

  // Top-selling dishes from today's paid orders (qty + revenue).
  const paidItems = await db.orderItem.findMany({
    where: {
      order: {
        restaurantId,
        status: "paid",
        paidAt: { gte: start, lt: end },
      },
    },
    select: {
      menuItemId: true,
      nameSnapshot: true,
      qty: true,
      priceCentsSnapshot: true,
    },
  });
  const dishAgg = new Map<
    string,
    { name: string; qty: number; revenue: number }
  >();
  for (const i of paidItems) {
    const e = dishAgg.get(i.menuItemId) ?? {
      name: i.nameSnapshot,
      qty: 0,
      revenue: 0,
    };
    e.qty += i.qty;
    e.revenue += i.qty * i.priceCentsSnapshot;
    dishAgg.set(i.menuItemId, e);
  }
  const topDishes = Array.from(dishAgg.values())
    .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue)
    .slice(0, 10);
  const dishesTotalQty = paidItems.reduce((s, i) => s + i.qty, 0);

  // Orders cancelled today (opened today and ended up cancelled).
  const cancelledCount = await db.order.count({
    where: {
      restaurantId,
      status: "cancelled",
      createdAt: { gte: start, lt: end },
    },
  });

  // Ratings posted during this day.
  const ratings = await db.dishRating.findMany({
    where: {
      restaurantId,
      createdAt: { gte: start, lt: end },
    },
    select: { stars: true },
  });
  const ratingsCount = ratings.length;
  const ratingsAvg =
    ratingsCount > 0
      ? ratings.reduce((s, r) => s + r.stars, 0) / ratingsCount
      : 0;

  const downloadHref = `/api/operator/reports/close-of-day?date=${dateIso}`;

  // Shift state — only meaningful for "today". For historical date views we
  // hide the live panel and just show the closed shift(s) for that date.
  const currentShift = isToday ? await getCurrentShift(restaurantId) : null;
  const shiftPanelInitial = currentShift
    ? {
        open: true as const,
        shift: {
          id: currentShift.id,
          openedAt: currentShift.openedAt.toISOString(),
          openingCashCents: currentShift.openingCashCents,
        },
        metrics: await computeOpenShiftMetrics(restaurantId, currentShift),
        openOrders: (await listOpenOrders(restaurantId, currentShift.openedAt)).map(
          (o) => ({
            id: o.id,
            shortCode: o.shortCode,
            status: o.status,
            subtotalCents: o.subtotalCents,
            totalCents: o.totalCents,
            tableLabel: o.table
              ? o.table.label ?? t("tableLabel", { number: o.table.number })
              : t("noTable"),
          }),
        ),
        expectedCashCents: 0, // computed below
      }
    : { open: false as const };
  if (shiftPanelInitial.open) {
    // Esperado en el cajón = saldo de la caja general (descuenta egresos
    // e ingresos y, en by_waiter, bases entregadas + devoluciones).
    shiftPanelInitial.expectedCashCents = cashSnap.general.balanceCents;
  }
  // Historial de cierres recientes (últimos 10) para mostrar bajo el panel.
  const recentClosed = await getRecentShifts(restaurantId, 10);

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-end justify-between flex-wrap gap-4 mb-6">
        <div>
          <div className="font-display text-3xl">{t("title")}</div>
          <p className="text-sm text-op-muted mt-1">
            {t("subtitle")}
          </p>
          {cutoff > 0 && (
            <p className="text-xs text-op-muted/80 mt-1">
              {t("dayWindowHint", {
                from: String(cutoff).padStart(2, "0"),
              })}
            </p>
          )}
        </div>
        <div className="flex items-end gap-3">
          <form action="/operator/reports" className="flex items-end gap-2">
            <label className="flex flex-col">
              <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                {t("dateLabel")}
              </span>
              <input
                type="date"
                name="date"
                defaultValue={dateIso}
                max={todayIso}
                className="h-9 px-3 rounded-lg border border-op-border bg-op-surface text-sm"
              />
            </label>
            <button
              type="submit"
              className="h-9 px-4 rounded-full bg-ink text-bone text-sm"
            >
              {t("viewCta")}
            </button>
          </form>
          <div className="inline-flex border border-op-border rounded-full bg-op-surface">
            <Link
              href={`/operator/reports?date=${prevDay}`}
              className="px-3 h-9 inline-flex items-center text-sm text-op-text/80"
              aria-label={t("prevDay")}
            >
              {"←"}
            </Link>
            <Link
              href={`/operator/reports?date=${todayIso}`}
              className={
                "px-3 h-9 inline-flex items-center text-xs " +
                (isToday ? "text-op-muted" : "text-op-text/80")
              }
            >
              {t("today")}
            </Link>
            <Link
              href={`/operator/reports?date=${nextDay}`}
              aria-disabled={isToday}
              aria-label={t("nextDay")}
              className={
                "px-3 h-9 inline-flex items-center text-sm " +
                (isToday ? "text-op-muted pointer-events-none opacity-40" : "text-op-text/80")
              }
            >
              {"→"}
            </Link>
          </div>
        </div>
      </div>

      {isToday && <ShiftPanel initial={shiftPanelInitial} />}

      {isToday && (
        <div className="mb-3">
          <CashBox
            initial={cashSnap}
            snapshotUrl="/api/operator/cash/snapshot"
            movementUrl="/api/operator/cash/movement"
            tenantSlug={tenant?.slug ?? ""}
          />
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <Stat label={t("statCharged")} value={fmtCOP(paymentsTotal)} hint={t("statChargedHint", { count: payments.length })} />
        <Stat label={t("statPaidOrders")} value={String(paidOrders.length)} hint={fmtCOP(subtotalTotal)} />
        <Stat label={t("statTips")} value={fmtCOP(tipsTotal)} hint={paidOrders.length ? t("statTipsHint", { amount: fmtCOP(Math.round(tipsTotal / paidOrders.length)) }) : t("emptyDash")} />
        <Stat label={t("statAvgTicket")} value={paidOrders.length ? fmtCOP(Math.round(subtotalTotal / paidOrders.length)) : t("emptyDash")} hint={t("statAvgTicketHint")} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat
          label={t("statDishesSold")}
          value={String(dishesTotalQty)}
          hint={t("statDishesSoldHint", { count: dishAgg.size })}
        />
        <Stat
          label={t("statCancelled")}
          value={String(cancelledCount)}
          hint={cancelledCount === 0 ? t("statCancelledNone") : t("statCancelledHint")}
        />
        <Stat
          label={t("statReviews")}
          value={String(ratingsCount)}
          hint={ratingsCount > 0 ? t("statReviewsHint", { avg: ratingsAvg.toFixed(1) }) : t("emptyDash")}
        />
        <Stat
          label={t("statDate")}
          value={dateIso}
          hint={isToday ? t("today") : t("statDateHistorical")}
        />
      </div>

      {/* Atajo a sub-reportes — el más usado por el admin es el de
          no-cobrados (cancelaciones + comps por mesero/plato/motivo). */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-4 mb-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("subreportsLabel")}
          </div>
          <div className="text-sm mt-0.5">
            {t("subreportsUncollected")}
          </div>
        </div>
        <Link
          href="/operator/reports/no-cobrados"
          className="h-9 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center shrink-0"
        >
          {t("open")}
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="bg-op-surface border border-op-border rounded-2xl p-5">
          <div className="flex items-baseline justify-between mb-3">
            <div className="font-display text-xl">{t("byMethodTitle")}</div>
            <a
              href={downloadHref}
              className="text-sm text-terracotta hover:underline"
            >
              {t("downloadCsv")}
            </a>
          </div>
          {byMethod.size === 0 && (
            <div className="text-sm text-op-muted py-6 text-center">
              {t("noChargesToday")}
            </div>
          )}
          {byMethod.size > 0 && (
            <ul className="divide-y divide-op-border">
              {Array.from(byMethod.entries()).map(([method, m]) => (
                <li key={method} className="py-2.5 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">
                      {methodLabel(method)}
                    </div>
                    <div className="text-[11px] text-op-muted">
                      {t("methodChargesCount", { count: m.count })}
                    </div>
                  </div>
                  <div className="font-mono tabular">{fmtCOP(m.sum)}</div>
                </li>
              ))}
              <li className="py-2.5 flex items-center justify-between border-t border-op-border mt-2">
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
                  {t("totalCharged")}
                </div>
                <div className="font-display text-xl">{fmtCOP(paymentsTotal)}</div>
              </li>
            </ul>
          )}
        </div>

        <div className="bg-op-surface border border-op-border rounded-2xl p-5">
          <div className="font-display text-xl mb-3">{t("topDishesTitle")}</div>
          {topDishes.length === 0 && (
            <div className="text-sm text-op-muted py-6 text-center">
              {t("noDishesSoldToday")}
            </div>
          )}
          {topDishes.length > 0 && (
            <ul className="divide-y divide-op-border">
              {topDishes.map((d, idx) => (
                <li
                  key={d.name + idx}
                  className="py-2.5 flex items-center gap-3"
                >
                  <span className="font-mono text-[10px] tabular w-5 text-op-muted text-right">
                    {(idx + 1).toString().padStart(2, "0")}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{d.name}</div>
                    <div className="text-[11px] text-op-muted">
                      {t("unitsCount", { count: d.qty })}
                    </div>
                  </div>
                  <div className="font-mono tabular text-sm shrink-0">
                    {fmtCOP(d.revenue)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <div className="bg-op-surface border border-op-border rounded-2xl p-5">
          <div className="font-display text-xl mb-3">{t("chargesTitle")}</div>
          <div className="overflow-auto max-h-[420px]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-op-surface">
                <tr className="text-left">
                  <Th>{t("thTime")}</Th>
                  <Th>{t("thOrder")}</Th>
                  <Th>{counterMode ? t("thChannel") : t("thTable")}</Th>
                  <Th>{t("thMethod")}</Th>
                  <Th align="right">{t("thAmount")}</Th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const bt = fmtBogotaDateTime(p.createdAt);
                  return (
                    <tr key={p.id} className="border-t border-op-border">
                      <Td className="font-mono tabular">{bt.time}</Td>
                      <Td className="font-mono">{p.order.shortCode}</Td>
                      <Td>{counterMode ? t("counterLabel") : p.order.table.number}</Td>
                      <Td>{methodLabel(p.method)}</Td>
                      <Td align="right" className="font-mono tabular">
                        {fmtCOP(p.amountCents)}
                      </Td>
                    </tr>
                  );
                })}
                {payments.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-op-muted">
                      {t("noChargesDate")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {recentClosed.length > 0 && (
        <div className="bg-op-surface border border-op-border rounded-2xl p-5 mt-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-display text-xl">{t("recentClosesTitle")}</div>
            <Link
              href="/operator/shifts"
              className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
            >
              {t("viewAll")}
            </Link>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <Th>{t("thClosed")}</Th>
                  <Th>{t("thDuration")}</Th>
                  <Th align="right">{t("thFund")}</Th>
                  <Th align="right">{t("thExpected")}</Th>
                  <Th align="right">{t("thCounted")}</Th>
                  <Th align="right">{t("thDifference")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {recentClosed.map((s) => {
                  const closed = s.closedAt ? fmtBogotaDateTime(s.closedAt) : null;
                  const durMin =
                    s.closedAt
                      ? Math.round(
                          (s.closedAt.getTime() - s.openedAt.getTime()) / 60_000,
                        )
                      : 0;
                  const hours = Math.floor(durMin / 60);
                  const mins = durMin % 60;
                  const diff = s.cashDiffCents ?? 0;
                  return (
                    <tr key={s.id} className="border-t border-op-border">
                      <Td className="font-mono tabular">
                        <div>
                          {closed
                            ? `${closed.date} ${closed.time}`
                            : t("emptyDash")}
                        </div>
                        <div className="text-[10px] text-op-muted normal-case tracking-normal">
                          {s.user
                            ? s.user.name ?? s.user.email
                            : t("recentOwnerLocal")}
                        </div>
                      </Td>
                      <Td>
                        {hours > 0 ? t("durationHm", { hours, mins }) : t("durationM", { mins })}
                      </Td>
                      <Td align="right" className="font-mono tabular">
                        {fmtCOP(s.openingCashCents)}
                      </Td>
                      <Td align="right" className="font-mono tabular">
                        {s.expectedCashCents != null ? fmtCOP(s.expectedCashCents) : t("emptyDash")}
                      </Td>
                      <Td align="right" className="font-mono tabular">
                        {s.declaredCashCents != null ? fmtCOP(s.declaredCashCents) : t("emptyDash")}
                      </Td>
                      <Td
                        align="right"
                        className={
                          "font-mono tabular " +
                          (diff === 0
                            ? "text-op-muted"
                            : diff > 0
                              ? "text-emerald-700"
                              : "text-red-700")
                        }
                      >
                        {diff === 0
                          ? t("emptyDash")
                          : (diff > 0 ? "+" : "−") + fmtCOP(Math.abs(diff))}
                      </Td>
                      <Td align="right">
                        <Link
                          href={`/operator/shifts/${s.id}`}
                          className="font-mono text-[11px] text-terracotta hover:underline whitespace-nowrap"
                        >
                          {t("open")}
                        </Link>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function validIso(s?: string) {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-op-surface border border-op-border rounded-2xl p-4">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display text-2xl mt-1 tabular">{value}</div>
      {hint && <div className="text-[11px] text-op-muted mt-0.5">{hint}</div>}
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={
        "px-3 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted " +
        (align === "right" ? "text-right" : "text-left")
      }
    >
      {children}
    </th>
  );
}
function Td({
  children,
  align,
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={
        "px-3 py-2 " + (align === "right" ? "text-right " : "") + (className ?? "")
      }
    >
      {children}
    </td>
  );
}
