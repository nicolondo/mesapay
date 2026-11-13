"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ordersHref, type OrdersSourceFilter, type OrdersView } from "@/lib/orders/ordersView";

const SOURCES: { id: OrdersSourceFilter; key: string }[] = [
  { id: "all", key: "sourceAll" }, { id: "tables", key: "sourceTables" }, { id: "manual", key: "sourceManual" },
];
export function OrdersSourceFilters({ view, today, tables }: {
  view: OrdersView; today: string; tables: { id: string; name: string }[];
}) {
  const t = useTranslations("opOrders");
  const router = useRouter();
  const customPeriod = view.period.desde !== today || view.period.hasta !== today;
  const missingTable = !!view.tableId && !tables.some((table) => table.id === view.tableId);
  return (
    <div className="flex min-w-0 flex-col gap-3 border-t border-op-border pt-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div role="group" aria-label={t("sourceFilterLabel")} className="flex min-w-0 flex-wrap items-center gap-1.5">
        {SOURCES.map((source) => (
          <Link key={source.id} href={ordersHref(view, today, { source: source.id })} prefetch={false} scroll={false}
            aria-current={view.source === source.id ? "true" : undefined}
            className={`inline-flex min-h-11 items-center rounded-lg border px-3 py-2 text-sm transition-colors ${view.source === source.id ? "border-op-text bg-op-text text-op-surface" : "border-op-border bg-op-surface text-op-muted hover:text-op-text"}`}>
            {t(source.key)}
          </Link>
        ))}
      </div>
      {view.source === "tables" && (
        <form action="/operator/orders" method="get" className="flex min-w-0 items-center gap-2 sm:ml-auto"
          onSubmit={(event) => { event.preventDefault(); const tableId = String(new FormData(event.currentTarget).get("tableId") ?? ""); router.push(ordersHref(view, today, { tableId }), { scroll: false }); }}>
          <input type="hidden" name="source" value="tables" />
          {view.status !== "all" && <input type="hidden" name="status" value={view.status} />}
          {view.q && <input type="hidden" name="q" value={view.q} />}
          {view.allDates && <input type="hidden" name="fechas" value="todas" />}
          {customPeriod && <><input type="hidden" name="desde" value={view.period.desde} /><input type="hidden" name="hasta" value={view.period.hasta} /></>}
          <label htmlFor="orders-table-filter" className="shrink-0 text-sm text-op-muted">{t("tableFilterLabel")}</label>
          <select id="orders-table-filter" name="tableId" value={view.tableId}
            onChange={(event) => router.push(ordersHref(view, today, { tableId: event.target.value }), { scroll: false })}
            className="h-11 min-w-0 flex-1 rounded-lg border border-op-border bg-op-bg px-3 text-sm sm:w-64 sm:flex-none">
            <option value="">{t("tableFilterAll")}</option>
            {missingTable && <option value={view.tableId}>{t("tableFilterUnavailable")}</option>}
            {tables.map((table) => <option key={table.id} value={table.id}>{table.name}</option>)}
          </select>
          <noscript><button type="submit" className="mp-btn mp-btn--secondary mp-btn--sm">{t("filterApply")}</button></noscript>
        </form>
      )}
    </div>
  );
}
