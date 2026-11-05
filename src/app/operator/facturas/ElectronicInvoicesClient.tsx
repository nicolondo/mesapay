"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  INVOICE_PAGE_SIZE,
  INVOICE_STATE_FILTERS,
  invoiceListHref,
  type InvoiceListParams,
  type InvoiceStateFilter,
} from "@/lib/dian/invoiceList";
import type {
  InvoiceListPage,
  InvoiceStateCounts,
  LateInvoiceRequest,
} from "@/lib/dian/invoiceListQueries";
import { invoicePageRange } from "@/lib/dian/invoiceRowView";
import { CREDIT_NOTES_PATH } from "@/lib/dian/creditNoteLink";
import { AttentionStrip } from "./AttentionStrip";
import type { EmissionInfo } from "./EmissionBanner";
import { InvoiceListItem, InvoiceTableRow } from "./InvoiceRow";

/**
 * /operator/facturas con facturación electrónica: las facturas que MESAPAY
 * emitió a la DIAN, con su estado, el correo al cliente y la nota crédito.
 *
 *   1. «Por atender» (`AttentionStrip`): sólo lo que pide a alguien —la
 *      emisión frenada, las rechazadas de los últimos 30 días, los clientes
 *      que pidieron factura cuando la cuenta ya había salido a consumidor
 *      final—, en una franja compacta.
 *   2. La lista en un panel: arriba los filtros en una sola barra (estado
 *      DIAN con su cuenta, rango de días operativos y búsqueda), en el medio
 *      una fila compacta por factura (`InvoiceRow`) y abajo la paginación.
 *
 * Los filtros viven en la URL (enlaces y un formulario GET): se pueden
 * compartir y el botón atrás funciona. Cambiarlos recarga la lista SIN
 * llevar la página arriba (`scroll={false}`), y «Anterior/Siguiente» deja
 * la vista al comienzo de la lista (`#facturas-lista`).
 */
export function ElectronicInvoicesClient({
  params,
  cutoffHour,
  list,
  counts,
  emission,
  rejected,
  late,
}: {
  params: InvoiceListParams;
  cutoffHour: number;
  list: InvoiceListPage;
  counts: InvoiceStateCounts;
  emission: EmissionInfo;
  rejected: { count: number; from: string; to: string };
  late: { items: LateInvoiceRequest[]; truncated: boolean };
}) {
  const t = useTranslations("opEInvoices");
  const tCredit = useTranslations("opCreditNotes");
  const filtered = params.state !== "all" || !!params.from || !!params.to || !!params.q;
  const range = invoicePageRange(list.page, list.rows.length, INVOICE_PAGE_SIZE);

  return (
    <div className="p-4 lg:p-6 max-w-7xl mx-auto w-full min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h1 className="font-display text-2xl lg:text-3xl">{t("title")}</h1>
          <p className="text-sm text-op-muted mt-1 max-w-2xl">{t("intro")}</p>
        </div>
        <Link href={CREDIT_NOTES_PATH} className="mp-btn mp-btn--secondary mp-btn--sm">
          {tCredit("title")}
        </Link>
      </div>

      <AttentionStrip emission={emission} rejected={rejected} late={late} params={params} />

      {/* Ancla de la paginación: «Anterior/Siguiente» deja la vista al
          comienzo de la lista (con sus filtros), no arriba de la página. */}
      <section
        id="facturas-lista"
        aria-label={t("listLabel")}
        className="@container scroll-mt-4 min-w-0 rounded-2xl border border-op-border bg-op-surface"
      >
        <Toolbar params={params} cutoffHour={cutoffHour} filtered={filtered} counts={counts} />

        <div className="@container min-w-0 border-t border-op-border">
          {list.rows.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-op-muted">
              {filtered || list.total > 0 ? t("emptyFiltered") : t("empty")}
            </div>
          ) : (
            <>
              {/* Ancho fijo por columna: las de datos cortos no se estiran y
                  cliente / estado se reparten el resto (con «…» y el texto
                  completo al pasar el puntero o en el detalle). */}
              <table className="hidden w-full table-fixed text-sm @4xl:table">
                <colgroup>
                  <col className="w-[6rem]" />
                  <col className="w-[6.25rem]" />
                  <col className="w-[17%]" />
                  <col className="w-[6.75rem]" />
                  <col />
                  <col className="w-[4rem]" />
                  <col className="w-[12.5rem]" />
                </colgroup>
                <thead>
                  <tr className="text-left">
                    <Th>{t("colNumber")}</Th>
                    <Th>{t("colDate")}</Th>
                    <Th>{t("colCustomer")}</Th>
                    <Th align="right">{t("colTotal")}</Th>
                    <Th>{t("colDian")}</Th>
                    <Th align="center">{t("colEmail")}</Th>
                    <Th align="right">
                      <span className="sr-only">{t("colActions")}</span>
                    </Th>
                  </tr>
                </thead>
                {list.rows.map((r) => (
                  <InvoiceTableRow key={r.id} row={r} />
                ))}
              </table>
              <ul className="divide-y divide-op-border @4xl:hidden">
                {list.rows.map((r) => (
                  <InvoiceListItem key={r.id} row={r} />
                ))}
              </ul>
            </>
          )}
        </div>

        <Pagination params={params} list={list} range={range} />
      </section>
    </div>
  );
}

// ── Filtros ───────────────────────────────────────────────────────────────

const STATE_LABEL: Record<InvoiceStateFilter, string> = {
  all: "stateAll",
  rejected: "stateRejected",
  in_process: "stateInProcess",
  accepted: "stateAccepted",
};

function Toolbar({
  params,
  cutoffHour,
  filtered,
  counts,
}: {
  params: InvoiceListParams;
  cutoffHour: number;
  filtered: boolean;
  counts: InvoiceStateCounts;
}) {
  const t = useTranslations("opEInvoices");
  const router = useRouter();
  // Cambiar un filtro recarga la lista, no la página: sin `scroll: false`
  // Next lleva la vista arriba de todo y se pierde dónde estaba el usuario.
  function applyFilters(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const qs = new URLSearchParams();
    for (const [k, v] of new FormData(e.currentTarget)) {
      if (typeof v === "string" && v.trim() !== "") qs.set(k, v.trim());
    }
    const query = qs.toString();
    router.push(query ? `/operator/facturas?${query}` : "/operator/facturas", { scroll: false });
  }
  const hintId = "facturas-dia-operativo";
  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 py-3 @6xl:flex-row @6xl:items-start @6xl:justify-between">
      <nav aria-label={t("filterState")} className="min-w-0 shrink-0">
        <div className="mp-seg mp-seg--sm mp-seg--grid-xs">
          {INVOICE_STATE_FILTERS.map((state) => {
            const active = params.state === state;
            return (
              <Link
                key={state}
                href={invoiceListHref({ ...params, state, page: 1 })}
                prefetch={false}
                scroll={false}
                aria-current={active ? "page" : undefined}
                data-active={active ? "true" : undefined}
                className="mp-seg__i"
              >
                {t(STATE_LABEL[state])}
                <span
                  className={
                    "rounded-md px-1.5 font-mono text-[11px] tabular leading-5 " +
                    (state === "rejected" && counts.rejected > 0
                      ? "bg-danger/10 text-danger"
                      : "bg-op-bg text-op-muted")
                  }
                >
                  {counts[state]}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>

      <form
        // Los campos no son controlados: al cambiar la URL sin recargar
        // (Quitar filtros, atrás) se vuelven a montar con los valores nuevos.
        key={`${params.from ?? ""}|${params.to ?? ""}|${params.q}`}
        action="/operator/facturas"
        onSubmit={applyFilters}
        role="search"
        className="grid min-w-0 grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap @6xl:flex-1 @6xl:justify-end"
      >
        {params.state !== "all" && <input type="hidden" name="state" value={params.state} />}
        <label className="col-span-2 min-w-0 sm:flex-1 sm:basis-56 @6xl:max-w-sm @6xl:basis-40">
          <span className="sr-only">{t("searchLabel")}</span>
          <span className="flex h-[38px] min-w-0 items-center gap-2 rounded-[var(--radius-btn)] border border-op-border-2 bg-op-surface px-3 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--terracotta-2)]">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-op-muted">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="search"
              name="q"
              defaultValue={params.q}
              maxLength={100}
              placeholder={t("searchPlaceholder")}
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-op-text outline-none placeholder:text-op-muted"
            />
          </span>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-op-muted sm:flex-row sm:items-center sm:gap-1.5">
          <span className="shrink-0">{t("filterFrom")}</span>
          <input
            type="date"
            name="from"
            defaultValue={params.from ?? ""}
            aria-describedby={hintId}
            className="h-[38px] w-full min-w-0 rounded-[var(--radius-btn)] border border-op-border-2 bg-op-surface px-2 text-sm text-op-text sm:w-auto"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-op-muted sm:flex-row sm:items-center sm:gap-1.5">
          <span className="shrink-0">{t("filterTo")}</span>
          <input
            type="date"
            name="to"
            defaultValue={params.to ?? ""}
            aria-describedby={hintId}
            className="h-[38px] w-full min-w-0 rounded-[var(--radius-btn)] border border-op-border-2 bg-op-surface px-2 text-sm text-op-text sm:w-auto"
          />
        </label>
        <button type="submit" className="mp-btn mp-btn--primary mp-btn--sm max-sm:col-span-2">
          {t("filterApply")}
        </button>
        {/* La aclaración del día operativo y «Quitar filtros» van en una
            línea aparte: la barra no se parte cuando hay filtros puestos. */}
        <div className="col-span-2 flex basis-full flex-wrap items-center justify-between gap-x-4 gap-y-1 @6xl:justify-end">
          <p id={hintId} className="text-[11px] text-op-muted">
            {t("businessDayHint", { hour: String(cutoffHour).padStart(2, "0") })}
          </p>
          {filtered && (
            <Link
              href="/operator/facturas"
              prefetch={false}
              scroll={false}
              className="inline-flex min-h-6 items-center text-xs font-medium text-op-muted underline underline-offset-4 hover:text-op-text"
            >
              {t("filterClear")}
            </Link>
          )}
        </div>
      </form>
    </div>
  );
}

// ── Paginación ────────────────────────────────────────────────────────────

function Pagination({
  params,
  list,
  range,
}: {
  params: InvoiceListParams;
  list: InvoiceListPage;
  range: { from: number; to: number };
}) {
  const t = useTranslations("opEInvoices");
  if (list.total === 0) return null;
  const prev = list.page > 1 ? `${invoiceListHref({ ...params, page: list.page - 1 })}#facturas-lista` : null;
  const next =
    list.page < list.pageCount ? `${invoiceListHref({ ...params, page: list.page + 1 })}#facturas-lista` : null;
  return (
    <nav
      aria-label={t("paginationLabel")}
      className="flex flex-wrap items-center justify-between gap-3 border-t border-op-border px-4 py-3 text-[13px]"
    >
      <span className="text-op-muted">
        {range.from > 0
          ? t("pageRange", { from: range.from, to: range.to, total: list.total })
          : t("pageTotal", { total: list.total })}
        {list.pageCount > 1 && (
          <span className="text-op-muted">
            {" · "}
            {t("pageOf", { page: list.page, pages: list.pageCount })}
          </span>
        )}
      </span>
      {(prev || next) && (
        <span className="flex gap-2">
          {prev ? (
            <Link href={prev} prefetch={false} className="mp-btn mp-btn--secondary mp-btn--xs">
              {t("pagePrev")}
            </Link>
          ) : null}
          {next ? (
            <Link href={next} prefetch={false} className="mp-btn mp-btn--secondary mp-btn--xs">
              {t("pageNext")}
            </Link>
          ) : null}
        </span>
      )}
    </nav>
  );
}

function Th({
  children,
  align,
  className = "",
}: {
  children?: React.ReactNode;
  align?: "right" | "center";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={
        "sticky top-0 z-10 bg-op-surface px-3 py-2 first:pl-4 last:pr-4 whitespace-nowrap font-mono text-[9px] font-normal uppercase tracking-[0.14em] text-op-muted shadow-[inset_0_-1px_0_var(--op-border)] " +
        (align === "right" ? "text-right " : align === "center" ? "text-center " : "") +
        className
      }
    >
      {children}
    </th>
  );
}
