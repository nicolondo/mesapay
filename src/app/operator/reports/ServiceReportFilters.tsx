import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { serviceReportHref, serviceReportPath, type ServiceReportFilters as Filters } from "@/lib/reports/serviceAdjustments";

const inputClass = "w-full min-w-0 rounded-xl border border-op-border bg-op-bg px-3 py-2.5 text-sm text-op-text focus:outline-none focus:ring-2 focus:ring-op-accent";

export default async function ServiceReportFilters({ filters }: { filters: Filters }) {
  const t = await getTranslations("serviceReports");
  const presets = ["today", "7d", "30d", "month", "all"] as const;
  return (
    <section aria-label={t("filters")} className="rounded-2xl border border-op-border bg-op-surface p-4 sm:p-5">
      <div className="mb-5 flex flex-wrap gap-2">
        {presets.map(range => (
          <Link key={range} prefetch={false}
            href={serviceReportHref(filters, { range, desde: null, hasta: null, page: 1 })}
            aria-current={filters.range === range ? "true" : undefined}
            className={`rounded-full border px-3 py-2 text-xs sm:text-sm ${filters.range === range ? "border-ink bg-ink text-bone" : "border-op-border hover:border-op-text"}`}>
            {t(`range${range}`)}
          </Link>
        ))}
      </div>
      <form action={serviceReportPath(filters.report)} method="get" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <input type="hidden" name="range" value={filters.range} />
        {filters.view === "items" && filters.report === "representation" && <input type="hidden" name="vista" value="productos" />}
        {filters.orderId && <input type="hidden" name="orderId" value={filters.orderId} />}
        <label className="space-y-1.5 text-xs font-medium text-op-muted">
          <span>{t("from")}</span>
          <input type="date" name="desde" defaultValue={filters.desde ?? ""} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-xs font-medium text-op-muted">
          <span>{t("to")}</span>
          <input type="date" name="hasta" defaultValue={filters.hasta ?? ""} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-xs font-medium text-op-muted">
          <span>{t("search")}</span>
          <input type="search" name="q" maxLength={160} defaultValue={filters.q ?? ""} placeholder={t("searchPlaceholder")} className={inputClass} />
        </label>
        <label className="space-y-1.5 text-xs font-medium text-op-muted">
          <span>{t("actorFilter")}</span>
          <input type="text" inputMode="email" name="email" maxLength={254} defaultValue={filters.email ?? ""} placeholder={t("actorPlaceholder")} className={inputClass} />
        </label>
        {filters.report === "uncollected" && (
          <label className="space-y-1.5 text-xs font-medium text-op-muted">
            <span>{t("type")}</span>
            <select name="kind" defaultValue={filters.kind} className={inputClass}>
              <option value="all">{t("allTypes")}</option>
              <option value="representation">{t("kindOrderComp")}</option>
              <option value="comp">{t("kindItemComp")}</option>
              <option value="cancel">{t("cancellations")}</option>
            </select>
          </label>
        )}
        <div className="flex flex-wrap items-end gap-3 sm:col-span-2 xl:col-span-3">
          <button type="submit" className="rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-bone">{t("apply")}</button>
          <Link prefetch={false} href={serviceReportPath(filters.report)} className="rounded-full px-3 py-2.5 text-sm text-op-muted underline underline-offset-4">{t("reset")}</Link>
        </div>
      </form>
      {filters.orderId && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-op-bg p-3 text-sm">
          <span>{t("singleOrderFilter")}</span>
          <Link prefetch={false} href={serviceReportHref(filters, { orderId: null, page: 1 })} className="underline underline-offset-4">{t("showAllOrders")}</Link>
        </div>
      )}
    </section>
  );
}
