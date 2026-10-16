import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { defaultLocale, isLocale } from "@/i18n/config";
import { formatDate, formatMoney, localeTag } from "@/lib/format";
import { displayOrderCode } from "@/lib/orderCode";
import { getServiceReport } from "@/lib/reports/serviceAdjustmentsQuery";
import {
  parseServiceReportFilters, serviceReportHref, serviceReportPath, serviceReportSearchParams,
  type ServiceReport, type ServiceReportFilters as Filters, type ServiceReportSearch,
} from "@/lib/reports/serviceAdjustments";
import ServiceReportFilters from "./ServiceReportFilters";

const kindKeys = { order_comp: "kindOrderComp", item_comp: "kindItemComp", item_cancel: "kindItemCancel", round_cancel: "kindRoundCancel" } as const;

export default async function ServiceAdjustmentsReport({ report, searchParams }: {
  report: ServiceReport; searchParams: Promise<ServiceReportSearch>;
}) {
  const [t, localeValue, ctx, query] = await Promise.all([getTranslations("serviceReports"), getLocale(), getErpContext([]), searchParams]);
  if (isDenied(ctx)) return <div className="p-6" role="alert">{t("noRestaurant")}</div>;
  const restaurant = await db.restaurant.findUnique({ where: { id: ctx.restaurantId }, select: { businessDayCutoffHour: true } });
  if (!restaurant) return <div className="p-6" role="alert">{t("noRestaurant")}</div>;
  const locale = isLocale(localeValue) ? localeValue : defaultLocale;
  let filters: Filters;
  try { filters = parseServiceReportFilters(report, query, restaurant.businessDayCutoffHour); }
  catch {
    return <div className="space-y-4 p-6"><p role="alert">{t("invalidFilters")}</p><Link prefetch={false} href={serviceReportPath(report)} className="underline">{t("reset")}</Link></div>;
  }
  const [result, currency] = await Promise.all([getServiceReport(ctx.restaurantId, filters), getCurrencyForCountry(ctx.country)]);
  const money = (amount: number | null) => amount === null ? t("unknownAmount") : formatMoney(amount, { currency, locale });
  const number = (value: number) => new Intl.NumberFormat(localeTag(locale)).format(value);
  const orders = filters.view === "orders";
  const representation = report === "representation";
  const exportParams = serviceReportSearchParams(filters, { page: 1 });
  exportParams.set("format", "csv");
  const exportHref = `/api${serviceReportPath(report)}?${exportParams}`;
  const firstRow = result.totals.rowCount ? (result.page - 1) * result.pageSize + 1 : 0;
  const lastRow = firstRow ? firstRow + result.rows.length - 1 : 0;

  return (
    <div className="mx-auto w-full min-w-0 max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <header className="space-y-4">
        <Link prefetch={false} href="/operator/reports" className="inline-flex text-sm text-op-muted hover:text-op-text">{t("back")}</Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="font-display text-3xl sm:text-4xl">{t(representation ? "representationTitle" : "uncollectedTitle")}</h1>
            <p className="mt-2 text-sm leading-relaxed text-op-muted">{t(representation ? "representationDescription" : "uncollectedDescription")}</p>
          </div>
          <a href={exportHref} className="inline-flex shrink-0 items-center rounded-full border border-op-border bg-op-surface px-5 py-2.5 text-sm font-medium hover:border-op-text">{t("download")}</a>
        </div>
        <nav aria-label={t("reportNavigation")} className="flex flex-wrap gap-2 border-b border-op-border pb-4">
          {(["representation", "uncollected"] as const).map(value => (
            <Link key={value} prefetch={false}
              href={serviceReportHref(filters, { report: value, view: value === "representation" ? "orders" : "items", kind: value === "representation" ? "representation" : "all", orderId: null, page: 1 })}
              aria-current={report === value ? "page" : undefined}
              className={`rounded-full px-4 py-2 text-sm ${report === value ? "bg-ink text-bone" : "text-op-muted hover:bg-op-surface"}`}>
              {t(value === "representation" ? "representationTitle" : "uncollectedTitle")}
            </Link>
          ))}
        </nav>
      </header>

      <ServiceReportFilters key={serviceReportSearchParams(filters).toString()} filters={filters} />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-op-border bg-op-border lg:grid-cols-4">
        <div className="col-span-2 bg-ink p-5 text-bone lg:col-span-1">
          <p className="text-xs opacity-75">{t("totalValue", { currency })}</p>
          <p data-testid="service-report-amount" className="mt-2 break-words font-display text-3xl">{money(result.totals.amountCents)}</p>
        </div>
        <div className="bg-op-surface p-5"><p className="text-xs text-op-muted">{t("orderCount")}</p><p data-testid="service-report-orders" className="mt-2 font-display text-3xl">{number(result.totals.orderCount)}</p></div>
        <div className="bg-op-surface p-5"><p className="text-xs text-op-muted">{t("quantity")}</p><p data-testid="service-report-quantity" className="mt-2 font-display text-3xl">{number(result.totals.quantity)}</p></div>
        <div className="col-span-2 bg-op-surface p-5 lg:col-span-1"><p className="text-xs text-op-muted">{t("lineCount")}</p><p className="mt-2 font-display text-3xl">{number(result.totals.lineCount)}</p></div>
      </div>
      <div className="space-y-2 text-xs leading-relaxed text-op-muted">
        <p>{t("valueNote")}</p>
        <p>{t("businessDayNote", { hour: String(restaurant.businessDayCutoffHour).padStart(2, "0") })}</p>
        {result.totals.unknownAmountCount > 0 && <p role="status" className="text-amber-800">{t("unknownAmountNote", { count: result.totals.unknownAmountCount })}</p>}
      </div>
      {!representation && (
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-op-muted">
          <span>{t("kindOrderComp")}{t("separator")}{money(result.totals.representationAmountCents)}</span>
          <span>{t("kindItemComp")}{t("separator")}{money(result.totals.compAmountCents)}</span>
          <span>{t("cancellations")}{t("separator")}{money(result.totals.cancelAmountCents)}</span>
        </div>
      )}

      <section className="min-w-0 overflow-hidden rounded-2xl border border-op-border bg-op-surface" aria-label={t("detail")}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-op-border p-4 sm:p-5">
          <h2 className="font-display text-2xl">{t("detail")}</h2>
          {representation && <nav aria-label={t("viewNavigation")} className="flex rounded-full border border-op-border p-1">
            {(["orders", "items"] as const).map(view => <Link key={view} prefetch={false}
              href={serviceReportHref(filters, { view, page: 1 })} aria-current={filters.view === view ? "true" : undefined}
              className={`rounded-full px-3 py-1.5 text-sm ${filters.view === view ? "bg-ink text-bone" : "text-op-muted"}`}>
              {t(view === "orders" ? "ordersView" : "itemsView")}
            </Link>)}
          </nav>}
        </div>
        <div className="hidden grid-cols-[1.05fr_1.3fr_1.6fr_.8fr] gap-5 border-b border-op-border bg-op-bg px-5 py-3 text-xs font-medium text-op-muted lg:grid">
          <span>{t("dateAndOrder")}</span><span>{t(orders ? "closure" : "product")}</span><span>{t("reasonAndActor")}</span><span className="text-right">{t("value")}</span>
        </div>
        {result.rows.length === 0 ? (
          <div className="px-5 py-14 text-center"><h3 className="font-display text-2xl">{t("emptyTitle")}</h3><p className="mt-2 text-sm text-op-muted">{t("emptyDescription")}</p></div>
        ) : <div className="divide-y divide-op-border">
          {result.rows.map(row => (
            <article key={row.id} data-testid="service-report-row" className="grid min-w-0 gap-4 p-4 sm:p-5 lg:grid-cols-[1.05fr_1.3fr_1.6fr_.8fr] lg:gap-5">
              <div className="min-w-0 text-sm">
                <time dateTime={row.eventAt.toISOString()} className="text-xs text-op-muted">{formatDate(row.eventAt, { locale })}</time>
                <p className="mt-1 font-medium">{row.tableNumber === null ? t("noTable") : t("tableNumber", { number: row.tableNumber })}{row.tableLabel ? ` · ${row.tableLabel}` : ""}</p>
                <Link prefetch={false} href={`/operator/orders/${row.orderId}`} title={row.shortCode ?? row.orderId} className="mt-1 inline-block text-xs underline underline-offset-4">{t("orderCode", { code: displayOrderCode(row.shortCode) || row.orderId.slice(0, 6) })}</Link>
              </div>
              <div className="min-w-0">
                <h3 className="break-words text-sm font-semibold">{orders ? row.name || t("wholeOrder") : t("productQuantity", { quantity: number(row.quantity), name: row.name || t("unnamedProduct") })}</h3>
                {orders && <p className="mt-1 text-xs text-op-muted">{t("unitsAndLines", { quantity: number(row.quantity), lines: number(row.lineCount) })}</p>}
                <p className="mt-2 inline-flex rounded-full border border-op-border px-2.5 py-1 text-[11px] text-op-muted">{t(kindKeys[row.kind])}</p>
                {orders && <div><Link prefetch={false} href={serviceReportHref(filters, { view: "items", orderId: row.orderId, q: null, email: null, page: 1 })} className="mt-2 inline-block text-xs underline underline-offset-4">{t("viewProducts")}</Link></div>}
              </div>
              <div className="min-w-0 text-sm">
                <span className="text-xs text-op-muted lg:hidden">{t("reasonAndActor")}</span>
                <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{row.reason || t("noReason")}</p>
                <p className="mt-2 break-all text-xs text-op-muted">{row.actorEmail || t("noActor")}</p>
              </div>
              <div className="flex items-start justify-between gap-4 border-t border-op-border pt-3 lg:block lg:border-0 lg:pt-0 lg:text-right">
                <span className="text-xs text-op-muted lg:hidden">{t("value")}</span>
                <div><p className="font-mono text-sm tabular-nums">{money(row.amountCents)}</p>
                  {row.missingDetail && <p className="mt-2 max-w-48 text-xs text-amber-800">{t("missingDetail")}</p>}
                </div>
              </div>
            </article>
          ))}
        </div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-op-border p-4 text-sm sm:p-5">
          <p className="text-op-muted">{t("pagination", { first: number(firstRow), last: number(lastRow), total: number(result.totals.rowCount) })}</p>
          <nav aria-label={t("paginationNavigation")} className="flex items-center gap-3">
            {result.page > 1 && <Link prefetch={false} href={serviceReportHref(filters, { page: result.page - 1 })} className="rounded-full border border-op-border px-4 py-2">{t("previous")}</Link>}
            <span className="text-xs text-op-muted">{t("page", { page: number(result.page), total: number(result.pageCount) })}</span>
            {result.page < result.pageCount && <Link prefetch={false} href={serviceReportHref(filters, { page: result.page + 1 })} className="rounded-full border border-op-border px-4 py-2">{t("next")}</Link>}
          </nav>
        </div>
      </section>
      <p className="text-xs leading-relaxed text-op-muted">{t("historyNote")}</p>
    </div>
  );
}
