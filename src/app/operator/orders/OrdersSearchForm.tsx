"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ordersHref, type OrdersView } from "@/lib/orders/ordersView";

/**
 * Búsqueda de la lista de Órdenes: código de la cuenta o número de factura
 * («FESM7913», «7913») / nota crédito («NC12»). Conserva el período y el
 * estado y vuelve a la página 1, SIN llevar la vista arriba de todo
 * (`scroll: false`, como los filtros de Facturas). Sin JavaScript sigue
 * siendo un GET normal con los mismos campos.
 */
export function OrdersSearchForm({ view, today }: { view: OrdersView; today: string }) {
  const t = useTranslations("opOrders");
  const router = useRouter();
  const customPeriod = !(view.period.desde === today && view.period.hasta === today);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = String(new FormData(e.currentTarget).get("q") ?? "").trim().slice(0, 100);
    router.push(ordersHref(view, today, { q }), { scroll: false });
  }

  return (
    <form
      role="search"
      action="/operator/orders"
      method="get"
      onSubmit={submit}
      className="flex w-full min-w-0 items-center gap-2 lg:w-auto"
    >
      {view.status !== "all" && <input type="hidden" name="status" value={view.status} />}
      {view.source !== "all" && <input type="hidden" name="source" value={view.source} />}
      {view.source === "tables" && view.tableId && <input type="hidden" name="tableId" value={view.tableId} />}
      {view.credit && <input type="hidden" name="credito" value="1" />}
      {customPeriod && (
        <>
          <input type="hidden" name="desde" value={view.period.desde} />
          <input type="hidden" name="hasta" value={view.period.hasta} />
        </>
      )}
      {view.allDates && <input type="hidden" name="fechas" value="todas" />}
      <div className="relative min-w-0 flex-1 lg:w-60 lg:flex-none xl:w-72">
        <svg
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-op-muted"
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          aria-hidden
        >
          <circle cx="9" cy="9" r="6" />
          <line x1="14" y1="14" x2="17.5" y2="17.5" />
        </svg>
        <input
          // La búsqueda viene de la URL: al cambiar, el campo se rehace.
          key={view.q}
          type="search"
          name="q"
          defaultValue={view.q}
          onChange={(e) => {
            if (e.currentTarget.value === "" && view.q) {
              router.push(ordersHref(view, today, { q: "" }), { scroll: false });
            }
          }}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          className="h-11 w-full min-w-0 rounded-lg border border-op-border bg-op-bg pl-9 pr-3 text-sm placeholder:text-op-muted focus:border-op-text/30 focus:outline-none lg:h-10"
        />
      </div>
      <button type="submit" className="mp-btn mp-btn--secondary mp-btn--sm shrink-0">
        {t("searchButton")}
      </button>
    </form>
  );
}
