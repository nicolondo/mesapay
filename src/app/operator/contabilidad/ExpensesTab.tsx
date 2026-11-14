"use client";

// Pestaña Gastos de Contabilidad: resumen, barra de filtros, lista y páginas.
//
// Todo lo que filtra vive en la URL (`?tab=expenses&month=…&q=…&supplier=…`,
// ver `@/lib/erp/expenseListParams`): recargar, compartir o volver atrás deja
// la lista igual. Cambiar un filtro navega SIN llevar la vista arriba
// (`scroll: false`, patrón de Facturas #584) y vuelve a la página 1. La
// lista, los totales y el conteo de cada estado los calcula el servidor con
// TODOS los filtros activos: «Por pagar» filtrado por proveedor es lo que se
// le debe a ese proveedor, no lo de la página visible.
//
// Escritorio (el contenedor ≥ 48rem): una fila de una línea por gasto en
// columnas — consecutivo, fecha, proveedor, categoría, total a pagar,
// estado. Celular: tarjeta de dos líneas.

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, localeTag } from "@/lib/format";
import { expensePayableCents } from "@/lib/erp/expenseTax";
import { formatExpenseNumber } from "@/lib/erp/expenseNumberFormat";
import {
  EXPENSE_STATUSES,
  expenseListParams,
  hasExpenseFilters,
  isIsoDay,
  parseExpenseListParams,
  type ExpenseListFilters,
  type ExpensePeriod,
  type ExpenseStatusFilter,
} from "@/lib/erp/expenseListParams";
import { SupplierCombobox } from "@/components/suppliers/SupplierCombobox";
import { AccountCombobox } from "@/components/accounts/AccountCombobox";
import { Icon } from "@/components/ui/Icon";
import type { ExpenseDto, SupplierRef } from "./ExpenseSheet";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/operator/expenses (ver expenseList.ts).

export type ExpenseRowDto = ExpenseDto & { overdue?: boolean };

type Summary = {
  count: number;
  costCents: number;
  payableCents: number;
  paidCents: number;
  outstandingCents: number;
  overdueCount: number;
  overdueCents: number;
};

export type ExpensesPayload = {
  expenses: ExpenseRowDto[];
  summary: Summary;
  counts: Record<ExpenseStatusFilter, number>;
  page: number;
  pageCount: number;
  pageSize: number;
  /** TODAS las plantillas recurrentes (no dependen del período). */
  templates: ExpenseDto[];
  /** Categorías ya usadas: datalist del formulario y filtro «Categoría». */
  categories: string[];
};

type AccountRef = { code: string; name: string; type: string };

/** Parámetros de la URL que son de la lista (se reemplazan juntos). */
const LIST_KEYS = ["month", "desde", "hasta", "fechas", "q", "supplier", "category", "account", "status", "page"];
const LIST_ID = "gastos-lista";

/* ─────────────────────────── Utilidades ────────────────────────────── */

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthName(month: string, locale: Locale): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const label = new Intl.DateTimeFormat(localeTag(locale), { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function monthBounds(month: string): { desde: string; hasta: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { desde: `${month}-01`, hasta: `${month}-${String(last).padStart(2, "0")}` };
}

/** Estado de pago de una fila: el mismo criterio del servidor. */
function rowStatus(e: ExpenseRowDto): { kind: "paid" | "pending" | "overdue"; outstanding: number; partial: boolean } {
  const payable = expensePayableCents(e);
  const outstanding = Math.max(0, payable - (e.paidCents ?? 0));
  if (outstanding === 0) return { kind: "paid", outstanding, partial: false };
  return { kind: e.overdue ? "overdue" : "pending", outstanding, partial: outstanding < payable };
}

/* ───────────────────────────── Pestaña ─────────────────────────────── */

export function ExpensesTab({
  month,
  currency,
  reloadSeq,
  suppliers,
  onOpen,
  onNew,
  onLoaded,
}: {
  /** Mes del selector compartido de Contabilidad (el período por defecto). */
  month: string;
  currency: string;
  /** Sube tras guardar/borrar: vuelve a pedir la página actual. */
  reloadSeq: number;
  /** Todos los proveedores (también los desactivados: pueden tener gastos). */
  suppliers: SupplierRef[];
  onOpen: (e: ExpenseDto) => void;
  onNew: () => void;
  /** Las categorías llegan con la lista: el formulario las usa en su datalist. */
  onLoaded: (payload: ExpensesPayload) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });

  // Filtros = la URL; sin período en la URL, el mes del selector compartido.
  const sp = new URLSearchParams(searchParams.toString());
  if (!sp.get("month") && !(isIsoDay(sp.get("desde")) && isIsoDay(sp.get("hasta"))) && sp.get("fechas") !== "todas") {
    sp.set("month", month);
  }
  const filters: ExpenseListFilters = parseExpenseListParams(sp) ?? {
    period: { kind: "month", month },
    q: "",
    supplierId: null,
    category: null,
    account: null,
    status: "all",
    page: 1,
  };
  const apiQuery = expenseListParams(filters).toString();
  const filtered = hasExpenseFilters(filters);

  function navigate(patch: Partial<ExpenseListFilters>, how: "push" | "replace" = "push") {
    const next: ExpenseListFilters = { ...filters, ...patch, page: patch.page ?? 1 };
    const params = new URLSearchParams(searchParams.toString());
    for (const k of LIST_KEYS) params.delete(k);
    for (const [k, v] of expenseListParams(next)) params.set(k, v);
    params.set("tab", "expenses");
    router[how](`${pathname}?${params.toString()}`, { scroll: false });
  }

  // ── Datos: la página viaja con SU consulta; mientras llega la nueva se
  // deja la anterior atenuada (sin parpadeo a «Cargando…»).
  const [loaded, setLoaded] = useState<{ key: string; payload: ExpensesPayload } | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const fetchKey = `${apiQuery}#${reloadSeq}`;
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/operator/expenses?${apiQuery}`, { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<ExpensesPayload>) : Promise.reject(new Error("load"))))
      .then((payload) => {
        setLoaded({ key: fetchKey, payload });
        setLoadErr(false);
        onLoadedRef.current(payload);
      })
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name !== "AbortError") setLoadErr(true);
      });
    return () => controller.abort();
  }, [apiQuery, fetchKey]);
  const data = loaded?.payload ?? null;
  const stale = loaded !== null && loaded.key !== fetchKey;

  // ── Cuentas para el filtro (perezoso: una vez por visita a la pestaña).
  const [accounts, setAccounts] = useState<AccountRef[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/api/operator/accounting/chart")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j: { accounts: AccountRef[] }) => {
        if (alive) setAccounts(j.accounts.filter((a) => (a.type === "gasto" || a.type === "costo") && a.code.length >= 4));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // ── Búsqueda: se aplica sola al dejar de escribir; la URL manda si cambia
  // por fuera («Quitar filtros», atrás).
  const [draft, setDraft] = useState(filters.q);
  const [lastUrlQ, setLastUrlQ] = useState(filters.q);
  if (filters.q !== lastUrlQ) {
    setLastUrlQ(filters.q);
    setDraft(filters.q);
  }
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  });
  useEffect(() => {
    const q = draft.trim().replace(/\s+/g, " ");
    if (q === filters.q) return;
    const timer = setTimeout(() => navigateRef.current({ q }, "replace"), 350);
    return () => clearTimeout(timer);
  }, [draft, filters.q]);

  const [moreOpen, setMoreOpen] = useState(false);
  const extraCount = [filters.supplierId, filters.category, filters.account].filter(Boolean).length;
  const supplierName = filters.supplierId ? suppliers.find((s) => s.id === filters.supplierId)?.name ?? null : null;

  function goToPage(page: number) {
    navigate({ page });
    // La lista arranca arriba de la página nueva (no toda la pantalla).
    const el = document.getElementById(LIST_ID);
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  }

  const exportHref = `/api/operator/accounting/export?book=expenses&${expenseListParams({ ...filters, page: 1 }).toString()}`;
  const summary = data?.summary;

  return (
    <div data-conta-wide className="@container space-y-3">
      {/* ── Resumen (del conjunto filtrado completo) y acciones ── */}
      <div className="flex flex-col gap-3 @3xl:flex-row @3xl:items-end @3xl:justify-between">
        <dl
          aria-live="polite"
          className={
            "grid grid-cols-2 divide-x divide-op-border rounded-xl border border-op-border bg-op-surface transition-opacity @3xl:inline-grid @3xl:grid-cols-[auto_auto_auto] " +
            (stale ? "opacity-60" : "")
          }
        >
          {/* En el celular el conteo ya está en «Todos N» del estado. */}
          <Stat
            className="hidden @3xl:block"
            label={t("expStatCount")}
            value={summary ? String(summary.count) : "—"}
            hint={filtered ? t("expStatFiltered") : undefined}
          />
          <Stat
            label={t("expStatPayable")}
            value={summary ? money(summary.payableCents) : "—"}
            hint={
              summary && summary.costCents !== summary.payableCents
                ? t("expStatCostHint", { amount: money(summary.costCents) })
                : undefined
            }
          />
          <Stat
            label={supplierName ? t("expStatOutstandingTo", { name: supplierName }) : t("expStatOutstanding")}
            value={summary ? money(summary.outstandingCents) : "—"}
            tone={summary && summary.overdueCents > 0 ? "danger" : summary && summary.outstandingCents > 0 ? "warn" : undefined}
            hint={
              summary
                ? summary.overdueCents > 0
                  ? t("expStatOverdueHint", { amount: money(summary.overdueCents) })
                  : summary.count > 0 && summary.outstandingCents === 0
                    ? t("expStatAllPaid")
                    : undefined
                : undefined
            }
          />
        </dl>
        <div className="flex items-center gap-2">
          <button type="button" onClick={onNew} className="mp-btn mp-btn--primary flex-1 @3xl:flex-none">
            <Icon name="plus" width={16} height={16} />
            {t("newExpense")}
          </button>
          <a href={exportHref} className="mp-btn mp-btn--secondary" title={t("expExportHint")}>
            {t("exportCsv")}
          </a>
        </div>
      </div>

      {/* ── Barra de filtros ── */}
      <section
        aria-label={t("expToolbarLabel")}
        className="mp-exp-filters flex flex-col gap-3 rounded-2xl border border-op-border bg-op-surface p-3"
      >
        <div className="flex flex-col gap-3 @3xl:flex-row @3xl:items-center">
          <PeriodControl period={filters.period} month={month} onChange={(period) => navigate({ period })} kinds="wide" />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">{t("expSearchLabel")}</span>
              <Icon
                name="search"
                width={16}
                height={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-op-muted"
              />
              <input
                type="search"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    navigate({ q: draft.trim().replace(/\s+/g, " ") }, "replace");
                  }
                }}
                maxLength={100}
                placeholder={t("expSearchPlaceholder")}
                className="h-11 w-full min-w-0 rounded-lg border border-op-border bg-op-bg pl-9 pr-3 text-sm placeholder:text-op-muted focus:border-op-text/30 focus:outline-none"
              />
            </label>
            {/* .mp-btn fija su display: el «sólo en el celular» va en un envoltorio. */}
            <span className="shrink-0 @3xl:hidden">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                aria-controls="gastos-mas-filtros"
                className={"mp-btn mp-btn--secondary " + (extraCount > 0 || filters.period.kind !== "month" ? "!border-op-text/40" : "")}
              >
                {extraCount > 0 ? t("expFiltersToggleCount", { count: extraCount }) : t("expFiltersToggle")}
              </button>
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2 @5xl:flex-row @5xl:items-center">
          <div className="mp-seg mp-seg--sm w-full shrink-0 @3xl:w-auto @3xl:self-start @5xl:self-auto" role="group" aria-label={t("expStatusLabel")}>
            {EXPENSE_STATUSES.map((s) => {
              const active = filters.status === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={active}
                  data-active={active ? "true" : undefined}
                  onClick={() => navigate({ status: s })}
                  className="mp-seg__i !h-auto min-h-[44px] min-w-0 flex-1 basis-0 flex-col !gap-0 !px-1.5 !py-1 justify-center @3xl:!h-8 @3xl:min-h-0 @3xl:flex-none @3xl:basis-auto @3xl:flex-row @3xl:!gap-1.5 @3xl:!px-3"
                >
                  <span className="truncate text-xs @3xl:text-[13px]">{t(`expStatus_${s}`)}</span>
                  <span className={"font-mono text-[11px] tabular-nums " + (s === "overdue" && (data?.counts.overdue ?? 0) > 0 ? "text-danger" : "text-op-muted")}>
                    {data ? data.counts[s] : "·"}
                  </span>
                </button>
              );
            })}
          </div>
          <div
            id="gastos-mas-filtros"
            className={(moreOpen ? "grid" : "hidden") + " min-w-0 grid-cols-1 gap-2 @3xl:grid @3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)] @5xl:flex-1"}
          >
            {/* Celular: el tipo de período (mes, fechas, todo) vive acá. */}
            <div className="@md:hidden">
              <PeriodKinds period={filters.period} month={month} onChange={(period) => navigate({ period })} />
            </div>
            <SupplierCombobox
              suppliers={suppliers}
              value={filters.supplierId && filters.supplierId !== "none" ? filters.supplierId : null}
              onChange={(id) => {
                if ((id ?? null) !== filters.supplierId) navigate({ supplierId: id ?? null });
              }}
              allowCreate={false}
              placeholder={t("expFilterSupplierAll")}
              aria-label={t("expFilterSupplier")}
            />
            <select
              value={filters.category ?? ""}
              onChange={(e) => navigate({ category: e.target.value || null })}
              aria-label={t("expFilterCategory")}
              className={
                "h-11 w-full min-w-0 rounded-lg border border-op-border bg-op-bg px-3 text-sm focus:border-op-text/30 focus:outline-none " +
                (filters.category ? "text-op-text" : "text-op-muted")
              }
            >
              <option value="">{t("expFilterCategoryAll")}</option>
              {[...new Set([...(data?.categories ?? []), ...(filters.category ? [filters.category] : [])])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <AccountCombobox
              accounts={accounts}
              value={filters.account}
              onChange={(code) => {
                if ((code ?? null) !== filters.account) navigate({ account: code ?? null });
              }}
              placeholder={t("expFilterAccountAll")}
              aria-label={t("expFilterAccount")}
            />
          </div>
          {filtered && (
            <button
              type="button"
              onClick={() => navigate({ q: "", supplierId: null, category: null, account: null, status: "all" })}
              className="shrink-0 self-start text-sm text-terracotta hover:underline min-h-[44px] @3xl:min-h-0 @3xl:self-auto"
            >
              {t("expFiltersClear")}
            </button>
          )}
        </div>
      </section>

      {/* ── Lista ── */}
      <section id={LIST_ID} aria-label={t("tabExpenses")} aria-busy={stale} className="scroll-mt-4">
        {loadErr && !data ? (
          <div role="alert" className="text-sm text-danger">
            {t("errLoadFailed")}
          </div>
        ) : !data ? (
          <ListSkeleton />
        ) : data.expenses.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-op-border bg-op-surface px-6 py-10 text-center">
            <div className="font-display text-lg mb-1">
              {filters.q
                ? t("expEmptySearch", { q: filters.q })
                : filtered
                  ? t("expEmptyFiltered")
                  : filters.period.kind === "month"
                    ? t("expensesEmptyTitle")
                    : t("expEmptyPeriod")}
            </div>
            {!filtered && <p className="text-sm text-op-muted">{t("expensesEmptyBody")}</p>}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {filtered && (
                <button
                  type="button"
                  onClick={() => navigate({ q: "", supplierId: null, category: null, account: null, status: "all" })}
                  className="mp-btn mp-btn--secondary mp-btn--sm"
                >
                  {t("expFiltersClear")}
                </button>
              )}
              {filters.period.kind !== "all" && (filtered || filters.period.kind === "range") && (
                <button type="button" onClick={() => navigate({ period: { kind: "all" } })} className="mp-btn mp-btn--secondary mp-btn--sm">
                  {t("expSearchAllDates")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <ul
            className={
              "flex flex-col gap-2 transition-opacity @3xl:gap-0 @3xl:rounded-2xl @3xl:border @3xl:border-op-border @3xl:bg-op-surface " +
              (stale ? "opacity-60" : "")
            }
          >
            <li
              aria-hidden
              className="hidden px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-op-muted @3xl:grid @3xl:rounded-t-2xl @3xl:bg-op-bg mp-exp-row"
            >
              <span>{t("expColNumber")}</span>
              <span>{t("expColDate")}</span>
              <span>{t("expColSupplier")}</span>
              <span>{t("expColCategory")}</span>
              <span className="text-right">{t("expColTotal")}</span>
              <span>{t("expColStatus")}</span>
            </li>
            {data.expenses.map((e) => (
              <ExpenseRow key={e.id} e={e} currency={currency} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </section>

      {data && data.summary.count > 0 && (
        <nav aria-label={t("expPagination")} className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-op-muted tabular-nums">
            {t("expPageShowing", {
              from: (data.page - 1) * data.pageSize + 1,
              to: Math.min(data.page * data.pageSize, data.summary.count),
              total: data.summary.count,
            })}
          </span>
          {data.pageCount > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() => goToPage(data.page - 1)}
                className="mp-btn mp-btn--secondary mp-btn--sm disabled:opacity-40"
              >
                {t("expPagePrev")}
              </button>
              <span className="px-1 text-xs text-op-muted tabular-nums">
                {t("expPageOf", { page: data.page, pages: data.pageCount })}
              </span>
              <button
                type="button"
                disabled={data.page >= data.pageCount}
                onClick={() => goToPage(data.page + 1)}
                className="mp-btn mp-btn--secondary mp-btn--sm disabled:opacity-40"
              >
                {t("expPageNext")}
              </button>
            </div>
          )}
        </nav>
      )}

      {/* Plantillas recurrentes (arriendo, nómina…): el cron las vuelve
          gasto del mes cuando llega su día. No dependen del filtro. */}
      {data && data.templates.length > 0 && <TemplatesSection templates={data.templates} currency={currency} onOpen={onOpen} />}
    </div>
  );
}

/* ─────────────────────────── Período ───────────────────────────────── */

/**
 * «Mes · Fechas · Todo». Mes: ‹ Octubre de 2026 › (el mismo mes del resto
 * de Contabilidad). Fechas: desde/hasta libres (se aplica con las dos
 * fechas). Todo: sin límite de fechas (útil para buscar). En el celular el
 * selector del tipo va dentro de «Filtros» (`PeriodKinds`) y a la vista
 * queda sólo el mes o las fechas.
 */
function PeriodControl({
  period,
  month,
  onChange,
  kinds,
}: {
  period: ExpensePeriod;
  month: string;
  onChange: (p: ExpensePeriod) => void;
  /** "wide": el selector del tipo se ve sólo con espacio (≥ 28rem). */
  kinds: "wide";
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const initial = period.kind === "range" ? period : monthBounds(period.kind === "month" ? period.month : month);
  const [desde, setDesde] = useState(initial.desde);
  const [hasta, setHasta] = useState(initial.hasta);
  // La URL manda: si el rango cambia por fuera (atrás, «Fechas» desde el
  // panel), los campos lo siguen — ajuste de estado durante el render.
  const periodKey = `${initial.desde}:${initial.hasta}`;
  const [lastPeriodKey, setLastPeriodKey] = useState(periodKey);
  if (periodKey !== lastPeriodKey) {
    setLastPeriodKey(periodKey);
    setDesde(initial.desde);
    setHasta(initial.hasta);
  }

  function applyRange(d: string, h: string) {
    if (isIsoDay(d) && isIsoDay(h)) onChange({ kind: "range", desde: d <= h ? d : h, hasta: d <= h ? h : d });
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 @md:flex-row @md:items-center">
      {kinds === "wide" && (
        <div className="hidden @md:block">
          <PeriodKinds period={period} month={month} onChange={onChange} />
        </div>
      )}
      {period.kind === "month" ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onChange({ kind: "month", month: shiftMonth(period.month, -1) })}
            aria-label={t("monthPrev")}
            className="mp-icobtn shrink-0"
          >
            <Chevron dir="left" />
          </button>
          <span className="min-w-0 flex-1 truncate text-center text-sm font-medium @md:w-40 @md:flex-none">
            {monthName(period.month, locale)}
          </span>
          <button
            type="button"
            onClick={() => onChange({ kind: "month", month: shiftMonth(period.month, 1) })}
            aria-label={t("monthNext")}
            className="mp-icobtn shrink-0"
          >
            <Chevron dir="right" />
          </button>
        </div>
      ) : period.kind === "range" ? (
        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0">
            <span className="sr-only">{t("expRangeFrom")}</span>
            <input
              type="date"
              value={desde}
              max={hasta || undefined}
              onChange={(e) => {
                setDesde(e.target.value);
                applyRange(e.target.value, hasta);
              }}
              className="h-11 w-full min-w-0 rounded-lg border border-op-border bg-op-bg px-2 text-sm focus:border-op-text/30 focus:outline-none"
            />
          </label>
          <label className="min-w-0">
            <span className="sr-only">{t("expRangeTo")}</span>
            <input
              type="date"
              value={hasta}
              min={desde || undefined}
              onChange={(e) => {
                setHasta(e.target.value);
                applyRange(desde, e.target.value);
              }}
              className="h-11 w-full min-w-0 rounded-lg border border-op-border bg-op-bg px-2 text-sm focus:border-op-text/30 focus:outline-none"
            />
          </label>
        </div>
      ) : (
        <span className="flex min-h-11 items-center justify-center text-sm text-op-muted @md:justify-start @md:px-1">
          {t("expPeriodAllLabel")}
        </span>
      )}
    </div>
  );
}

/** El tipo de período: Mes · Fechas · Todo. «Fechas» arranca con el mes a la vista. */
function PeriodKinds({
  period,
  month,
  onChange,
}: {
  period: ExpensePeriod;
  month: string;
  onChange: (p: ExpensePeriod) => void;
}) {
  const t = useTranslations("opErp");
  const current = period.kind === "month" ? period.month : month;
  return (
    <div className="mp-seg mp-seg--sm w-full @md:w-auto" role="group" aria-label={t("expPeriodLabel")}>
      {(["month", "range", "all"] as const).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={period.kind === k}
          data-active={period.kind === k ? "true" : undefined}
          onClick={() => {
            if (k === period.kind) return;
            if (k === "month") onChange({ kind: "month", month: current });
            else if (k === "all") onChange({ kind: "all" });
            else onChange({ kind: "range", ...monthBounds(current) });
          }}
          className="mp-seg__i min-h-[44px] flex-1 @md:min-h-0 @md:flex-none"
        >
          {t(`expPeriod_${k}`)}
        </button>
      ))}
    </div>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
    </svg>
  );
}

/* ───────────────────────────── Fila ────────────────────────────────── */

function ExpenseRow({ e, currency, onOpen }: { e: ExpenseRowDto; currency: string; onOpen: (e: ExpenseDto) => void }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });
  const number = formatExpenseNumber(e.number);
  const payable = expensePayableCents(e);
  const status = rowStatus(e);
  const sameYear = new Date(e.date).getUTCFullYear() === new Date().getUTCFullYear();
  const date = formatDate(e.date, {
    locale,
    dateStyle: undefined,
    timeStyle: undefined,
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const supplier = e.supplier?.name ?? null;
  const costTitle = payable !== e.amountCents ? t("expRowCostTitle", { amount: money(e.amountCents) }) : undefined;
  const pill = <StatusPill status={status} money={money} />;

  return (
    <li className="relative rounded-2xl border border-op-border bg-op-surface transition-colors hover:bg-op-bg/60 @3xl:rounded-none @3xl:border-0 @3xl:border-t @3xl:bg-transparent @3xl:last:rounded-b-2xl">
      <button
        type="button"
        onClick={() => onOpen(e)}
        aria-label={number ? t("expRowOpen", { number, concept: e.category }) : t("expRowOpenNoNumber", { concept: e.category })}
        className="block w-full text-left rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta @3xl:rounded-none"
      >
        {/* Escritorio: una línea en columnas. */}
        <span className="hidden min-h-11 px-4 py-1.5 text-sm @3xl:grid mp-exp-row">
          <span className="font-mono text-[13px] text-op-text">{number ?? "—"}</span>
          <span className="truncate text-[13px] text-op-muted tabular-nums">{date}</span>
          <span className={"truncate " + (supplier ? "" : "text-op-muted")} title={e.supplier?.taxId ? `${supplier} · ${e.supplier.taxId}` : undefined}>
            {supplier ?? t("expNoSupplier")}
          </span>
          <span className="min-w-0 truncate">
            {e.category}
            {e.documentNumber && <span className="ml-2 font-mono text-[11px] text-op-muted">{e.documentNumber}</span>}
          </span>
          <span className="text-right font-mono tabular-nums" title={costTitle}>
            {money(payable)}
          </span>
          <span className="min-w-0">{pill}</span>
        </span>

        {/* Celular: dos líneas. */}
        <span className="block px-4 py-2.5 @3xl:hidden">
          <span className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm font-medium">{e.category}</span>
            <span className="shrink-0 font-mono text-sm font-medium tabular-nums" title={costTitle}>
              {money(payable)}
            </span>
          </span>
          <span className="mt-1 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[12px] text-op-muted">
              {number && <span className="font-mono text-op-text">{number}</span>}
              {number && <span aria-hidden>{" · "}</span>}
              <span className="tabular-nums">{date}</span>
              {supplier && <span aria-hidden>{" · "}</span>}
              {supplier}
            </span>
            <span className="shrink-0">{pill}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

function StatusPill({
  status,
  money,
}: {
  status: ReturnType<typeof rowStatus>;
  money: (c: number) => string;
}) {
  const t = useTranslations("opErp");
  const base = "inline-flex h-5 max-w-full items-center truncate rounded-full px-2 text-[11px] font-medium whitespace-nowrap tabular-nums ";
  if (status.kind === "paid") return <span className={base + "bg-[#2E6B4C]/12 text-[#1E5339] mp-exp-pill--ok"}>{t("expPill_paid")}</span>;
  const label =
    status.kind === "overdue"
      ? status.partial
        ? t("expPill_overduePartial", { amount: money(status.outstanding) })
        : t("expPill_overdue")
      : status.partial
        ? t("expPill_partial", { amount: money(status.outstanding) })
        : t("expPill_pending");
  return (
    <span className={base + (status.kind === "overdue" ? "bg-danger/10 text-danger" : "bg-[#C98A2E]/20 text-[#8F6828] mp-exp-pill--warn")}>
      {label}
    </span>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
  className = "",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warn" | "danger";
  className?: string;
}) {
  return (
    <div className={"min-w-0 px-3 py-2.5 @3xl:px-5 " + className}>
      <dt className="truncate font-mono text-[9px] uppercase tracking-[0.14em] text-op-muted" title={label}>
        {label}
      </dt>
      <dd
        className={
          "mt-0.5 truncate font-mono text-base font-medium tabular-nums @3xl:text-lg " +
          (tone === "danger" ? "text-danger" : tone === "warn" ? "text-[#8F6828] mp-exp-pill--warn" : "")
        }
      >
        {value}
      </dd>
      {hint && <dd className="truncate text-[10px] text-op-muted">{hint}</dd>}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div aria-hidden className="space-y-2 @3xl:space-y-0 @3xl:rounded-2xl @3xl:border @3xl:border-op-border @3xl:bg-op-surface">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-14 rounded-2xl border border-op-border bg-op-surface @3xl:h-11 @3xl:rounded-none @3xl:border-0 @3xl:border-t first:@3xl:border-t-0">
          <div className="mx-4 mt-4 h-3 w-1/2 rounded bg-op-bg @3xl:mt-4 @3xl:w-2/3" />
        </div>
      ))}
    </div>
  );
}

/* ──────────────────────── Plantillas recurrentes ───────────────────── */

/**
 * Plantillas (recurring: true) colapsadas por defecto: son configuración, no
 * el movimiento del período. No llevan consecutivo; sus copias sí.
 */
function TemplatesSection({
  templates,
  currency,
  onOpen,
}: {
  templates: ExpenseDto[];
  currency: string;
  onOpen: (e: ExpenseDto) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState(false);

  return (
    <section className="overflow-hidden rounded-2xl border border-op-border bg-op-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-op-bg"
      >
        <span className="text-sm font-medium">{t("expenseTemplatesTitle", { count: templates.length })}</span>
        <span className={"text-op-muted transition-transform " + (open ? "rotate-90" : "")} aria-hidden>
          <Chevron dir="right" />
        </span>
      </button>
      {open &&
        templates.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => onOpen(e)}
            className="flex w-full items-center gap-3 border-t border-op-border px-4 py-2.5 text-left hover:bg-op-bg"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{e.category}</span>
              <span className="block truncate text-[12px] text-op-muted">
                {[t("recurringEveryMonth", { day: e.recurringDay ?? 1 }), e.supplier?.name].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="shrink-0 font-mono text-sm tabular-nums">
              {formatMoney(expensePayableCents(e), { currency, locale, fractionDigits: "auto" })}
            </span>
          </button>
        ))}
    </section>
  );
}
