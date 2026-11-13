"use client";

import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { SupplierCombobox } from "@/components/suppliers/SupplierCombobox";
import {
  EmptyState,
  ListPagination,
  SearchBox,
  SelectField,
  Td,
  Th,
  type useListNavigation,
} from "@/components/billingCustomers/ListControls";
import {
  hasPurchaseFilters,
  purchaseListHref,
  statusFiltersFor,
  tabHref,
  type PurchaseListParams,
  type PurchaseStatusFilter,
  type PurchaseTab,
} from "@/lib/erp/purchaseList";
import type { PurchaseListPage, PurchaseListRow } from "@/lib/erp/purchaseList";
import { PayStatusChip, STATUS_KEYS, StatusChip, padNumber } from "./chips";
import { CREDIT_NOTES_PATH } from "@/lib/erp/supplierCreditNoteList";

export type FilterSupplier = { id: string; name: string; taxId: string | null };

/**
 * Lista de Compras (pestañas «Órdenes» y «Por pagar»), con el patrón de
 * Clientes/Facturas: los filtros viven en la URL (atrás y recargar los
 * conservan; cambiar uno no lleva la página arriba), el servidor busca,
 * filtra, pagina y calcula el resumen —total a pagar, vencido y total de
 * las compras— sobre TODO lo que cumple los filtros, no sólo esta página.
 * Mientras llega la respuesta la lista se atenúa.
 */
export function ComprasList({
  list,
  params,
  suppliers,
  currency,
  nav,
  onOpenDetail,
  onPay,
  onEditInvoice,
}: {
  list: PurchaseListPage;
  params: PurchaseListParams;
  suppliers: FilterSupplier[];
  currency: string;
  nav: ReturnType<typeof useListNavigation>;
  onOpenDetail: (id: string) => void;
  onPay: (row: PurchaseListRow) => void;
  onEditInvoice: (row: PurchaseListRow) => void;
}) {
  const t = useTranslations("opErp");
  const tc = useTranslations("opSupplierCredit");
  const locale = useLocale() as Locale;
  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const filtered = hasPurchaseFilters(params);
  const hrefWith = (patch: Partial<PurchaseListParams>) => purchaseListHref({ ...params, page: 1, ...patch });
  const unpaid = params.tab === "unpaid";
  // En el celular los filtros (proveedor, estado, fechas) van plegados bajo
  // «Filtros» para que la lista suba; con alguno activo arrancan abiertos.
  const activeFilters = [params.supplier, params.status !== "all", params.from, params.to].filter(Boolean).length;
  const [filtersOpen, setFiltersOpen] = useState(activeFilters > 0);

  const STATUS_LABEL: Record<PurchaseStatusFilter, string> = {
    all: t("filterAllStatuses"),
    draft: t(STATUS_KEYS.draft),
    sent: t(STATUS_KEYS.sent),
    partially_received: t(STATUS_KEYS.partially_received),
    received: t(STATUS_KEYS.received),
    canceled: t(STATUS_KEYS.canceled),
    paid: t("plStatusPaid"),
    overdue: t("plStatusOverdue"),
    partial: t("plStatusPartial"),
    pending: t("plStatusPending"),
  };
  const statusOptions = statusFiltersFor(params.tab).map((value) => ({ value, label: STATUS_LABEL[value] }));
  const clearHref = purchaseListHref({ tab: params.tab });
  const clearLink = (
    <Link href={clearHref} prefetch={false} scroll={false} className="mp-btn mp-btn--ghost mp-btn--sm">
      {t("plClearFilters")}
    </Link>
  );

  return (
    <section aria-label={t("comprasTitle")} className="@container space-y-4">
      {/* Pestañas como enlaces: cada una es una URL y conserva búsqueda, proveedor y fechas. */}
      <nav aria-label={t("plTabsLabel")}>
        <div className="mp-seg w-full sm:w-auto">
          {(
            [
              ["orders", t("tabOrders")],
              ["unpaid", t("tabUnpaid")],
            ] as [PurchaseTab, string][]
          ).map(([tab, label]) => (
            <Link
              key={tab}
              href={tabHref(params, tab)}
              prefetch={false}
              scroll={false}
              aria-current={params.tab === tab ? "page" : undefined}
              data-active={params.tab === tab ? "true" : undefined}
              className="mp-seg__i flex-1 sm:flex-none justify-center"
            >
              {label}
            </Link>
          ))}
          {/* Notas crédito de proveedores: su propia página (filtros aparte). */}
          <Link href={CREDIT_NOTES_PATH} prefetch={false} className="mp-seg__i flex-1 sm:flex-none justify-center">
            {tc("tabCreditNotes")}
          </Link>
        </div>
      </nav>

      <SummaryStrip list={list} params={params} money={money} filtered={filtered} />

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 @4xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1.1fr)_10rem_9.5rem_9.5rem] @4xl:items-end">
        <div className="min-w-0">
          <div aria-hidden className="hidden @4xl:block font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
            {t("plSearchShort")}
          </div>
          <SearchBox
            id="purchases-search"
            label={t("plSearchLabel")}
            placeholder={t("plSearchPlaceholder")}
            value={params.q}
            onSearch={(q) => nav.go(hrefWith({ q }), "replace")}
          />
        </div>
        {/* Envoltura: el display de .mp-btn le gana a la utilidad `hidden`. */}
        <div className="@4xl:hidden">
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          aria-expanded={filtersOpen}
          aria-controls="purchases-filters"
          className="mp-btn mp-btn--secondary h-11"
        >
          {t("plFiltersToggle")}
          {activeFilters > 0 && (
            <span className="ml-1 inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-ink px-1.5 text-[11px] text-bone tabular">
              {activeFilters}
            </span>
          )}
        </button>
        </div>
        <div
          id="purchases-filters"
          className={`${filtersOpen ? "grid" : "hidden"} col-span-2 grid-cols-2 gap-3 @4xl:contents`}
        >
        <div className="col-span-2 min-w-0 @4xl:col-span-1">
          <label
            htmlFor="purchases-supplier"
            className="block font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1"
          >
            {t("plFilterSupplier")}
          </label>
          <SupplierCombobox
            id="purchases-supplier"
            suppliers={suppliers}
            value={params.supplier || null}
            allowCreate={false}
            placeholder={t("plSupplierPlaceholder")}
            onChange={(id) => {
              if ((id ?? "") !== params.supplier) nav.go(hrefWith({ supplier: id ?? "" }));
            }}
          />
        </div>
        <SelectField
          id="purchases-status"
          label={t("plFilterStatus")}
          value={params.status}
          options={statusOptions}
          onChange={(status) => nav.go(hrefWith({ status }))}
          className="col-span-2 @4xl:col-span-1"
        />
        <DateField
          id="purchases-from"
          label={t("plFilterFrom")}
          value={params.from}
          max={params.to || undefined}
          onChange={(from) => nav.go(hrefWith({ from }))}
        />
        <DateField
          id="purchases-to"
          label={t("plFilterTo")}
          value={params.to}
          min={params.from || undefined}
          onChange={(to) => nav.go(hrefWith({ to }))}
        />
        </div>
      </div>

      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-op-muted tabular" aria-live="polite">
          {t("plResultCount", { count: list.total })}
        </span>
        {filtered && list.total > 0 && clearLink}
      </div>

      <div aria-busy={nav.pending} className={`transition-opacity duration-150 ${nav.pending ? "opacity-55" : ""}`}>
        {list.total === 0 ? (
          filtered ? (
            <EmptyState title={t("plNoMatches")} body={t("plNoMatchesHint")} action={clearLink} />
          ) : unpaid ? (
            <EmptyState title={t("unpaidEmpty")} />
          ) : (
            <EmptyState title={t("emptyOrdersTitle")} body={t("emptyOrdersBody")} />
          )
        ) : unpaid ? (
          <UnpaidRows rows={list.rows} money={money} locale={locale} onOpenDetail={onOpenDetail} onPay={onPay} onEditInvoice={onEditInvoice} />
        ) : (
          <OrderRows rows={list.rows} money={money} locale={locale} onOpenDetail={onOpenDetail} />
        )}
        <ListPagination
          from={list.from}
          to={list.to}
          total={list.total}
          prevHref={list.page > 1 ? purchaseListHref({ ...params, page: list.page - 1 }) : null}
          nextHref={list.page < list.pageCount ? purchaseListHref({ ...params, page: list.page + 1 }) : null}
        />
      </div>
    </section>
  );
}

/** Fecha con su etiqueta arriba (mismo alto y estilo que los selectores). */
function DateField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
        {label}
      </label>
      <input
        id={id}
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full min-w-0 rounded-[var(--radius-btn)] border border-op-border-2 bg-op-surface px-3 text-base sm:text-sm text-op-text focus:outline-none focus:border-op-accent focus:ring-2 focus:ring-op-accent/25"
      />
    </div>
  );
}

// ── Resumen ───────────────────────────────────────────────────────────────

function SummaryStrip({
  list,
  params,
  money,
  filtered,
}: {
  list: PurchaseListPage;
  params: PurchaseListParams;
  money: (cents: number) => string;
  filtered: boolean;
}) {
  const t = useTranslations("opErp");
  const s = list.summary;
  const payableHref = purchaseListHref({ ...params, tab: "unpaid", status: "all", page: 1 });
  const overdueHref = purchaseListHref({ ...params, tab: "unpaid", status: "overdue", page: 1 });
  return (
    <section aria-label={t("plSummaryLabel")}>
      <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-3 @3xl:gap-3">
        <div className="col-span-2 @3xl:col-span-1">
          <SummaryTile
            label={t("plSumPayable")}
            value={money(s.payableCents)}
            sub={t("plSumPayableSub", { count: s.payableCount })}
            href={payableHref}
            active={params.tab === "unpaid" && params.status === "all"}
            tone={s.payableCents > 0 ? "accent" : undefined}
          />
        </div>
        <SummaryTile
          label={t("plSumOverdue")}
          value={money(s.overdueCents)}
          sub={t("plSumOverdueSub", { count: s.overdueCount })}
          href={overdueHref}
          active={params.tab === "unpaid" && params.status === "overdue"}
          tone={s.overdueCents > 0 ? "danger" : undefined}
        />
        <SummaryTile
          label={t(params.tab === "unpaid" ? "plSumInvoiced" : "plSumTotal")}
          value={money(s.totalCents)}
          sub={t("plSumTotalSub", { count: s.count })}
        />
      </div>
      {filtered && <p className="mt-2 text-[11px] text-op-muted">{t("plSumFilteredNote")}</p>}
    </section>
  );
}

const TONE_TEXT = {
  accent: "text-op-accent",
  danger: "text-[color-mix(in_srgb,var(--danger)_85%,var(--op-text))]",
} as const;

function SummaryTile({
  label,
  value,
  sub,
  href,
  active,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  href?: string;
  active?: boolean;
  tone?: keyof typeof TONE_TEXT;
}) {
  const body = (
    <>
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-op-muted">{label}</span>
      <span className={`mt-0.5 block font-semibold tabular text-lg @3xl:mt-1 @3xl:text-2xl break-words ${tone ? TONE_TEXT[tone] : ""}`}>
        {value}
      </span>
      {/* En el celular la tarjeta queda en etiqueta + cifra: la lista sube. */}
      <span className="mt-0.5 hidden text-xs text-op-muted @xl:block">{sub}</span>
    </>
  );
  const base = "block h-full min-w-0 rounded-2xl border bg-op-surface px-3.5 py-2.5 @3xl:px-4 @3xl:py-3";
  if (!href) return <div className={`${base} border-op-border`}>{body}</div>;
  return (
    <Link
      href={href}
      prefetch={false}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={`${base} transition-[border-color,box-shadow] duration-150 hover:border-op-border-2 hover:shadow-[var(--shadow-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-op-accent/40 ${
        active ? "border-op-text shadow-[var(--shadow-1)]" : "border-op-border"
      }`}
    >
      {body}
    </Link>
  );
}

// ── Filas: Órdenes ────────────────────────────────────────────────────────

type RowProps = {
  rows: PurchaseListRow[];
  money: (cents: number) => string;
  locale: Locale;
  onOpenDetail: (id: string) => void;
};

function InvoiceText({ row }: { row: PurchaseListRow }) {
  const t = useTranslations("opErp");
  return row.supplierInvoiceNumber ? (
    <span className="font-mono text-[13px]">{row.supplierInvoiceNumber}</span>
  ) : (
    <span className="text-op-muted">{t("noInvoiceNumber")}</span>
  );
}

function OrderRows({ rows, money, locale, onOpenDetail }: RowProps) {
  const t = useTranslations("opErp");
  const poLabel = (r: PurchaseListRow) => t("poNumber", { number: padNumber(r.number) });
  return (
    <>
      <div className="hidden @min-[56rem]:block overflow-hidden rounded-2xl border border-op-border bg-op-surface">
        <table className="w-full text-sm">
          <thead className="bg-op-bg">
            <tr>
              <Th>{t("plColPurchase")}</Th>
              <Th>{t("plColDate")}</Th>
              <Th>{t("plColSupplier")}</Th>
              <Th>{t("plColInvoice")}</Th>
              <Th>{t("plColStatus")}</Th>
              <Th align="right">{t("plColTotal")}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-op-border transition-colors hover:bg-op-bg/50">
                <Td className="whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => onOpenDetail(r.id)}
                    className="font-medium underline-offset-2 hover:underline focus-visible:underline"
                    aria-label={t("plOpenPurchase", { number: poLabel(r) })}
                  >
                    {poLabel(r)}
                  </button>
                  <span className="block text-xs text-op-muted">{t("poLineCount", { count: r.itemCount })}</span>
                </Td>
                <Td className="whitespace-nowrap text-op-muted">{formatDate(r.createdAt, { locale, timeStyle: undefined })}</Td>
                <Td className="w-full max-w-0">
                  <span className="block truncate" title={r.supplier.name}>
                    {r.supplier.name}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  <InvoiceText row={r} />
                </Td>
                <Td className="whitespace-nowrap">
                  <span className="inline-flex gap-1">
                    <StatusChip status={r.status} />
                    {r.payStatus && <PayStatusChip status={r.payStatus} />}
                  </span>
                </Td>
                <Td align="right" className="whitespace-nowrap font-medium tabular">
                  {money(r.orderTotalCents)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="@min-[56rem]:hidden overflow-hidden rounded-2xl border border-op-border bg-op-surface">
        {rows.map((r) => (
          <li key={r.id} className="border-b border-op-border last:border-b-0">
            <button
              type="button"
              onClick={() => onOpenDetail(r.id)}
              className="w-full text-left px-4 py-2.5 hover:bg-op-bg"
              aria-label={t("plOpenPurchase", { number: poLabel(r) })}
            >
              <span className="flex items-center gap-3">
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium shrink-0">{poLabel(r)}</span>
                    <span className="text-sm text-op-muted truncate">{r.supplier.name}</span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-op-muted">
                    <span>{formatDate(r.createdAt, { locale, timeStyle: undefined })}</span>
                    {r.supplierInvoiceNumber && <span>{`· ${t("invoiceLabel", { number: r.supplierInvoiceNumber })}`}</span>}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    <StatusChip status={r.status} />
                    {r.payStatus && <PayStatusChip status={r.payStatus} />}
                  </span>
                </span>
                <span className="text-sm font-medium tabular shrink-0">{money(r.orderTotalCents)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// ── Filas: Por pagar ──────────────────────────────────────────────────────

function DueText({ row, locale }: { row: PurchaseListRow; locale: Locale }) {
  const t = useTranslations("opErp");
  if (!row.invoiceDueAt) return <span className="text-op-muted">{"—"}</span>;
  const overdue = row.payStatus === "overdue";
  return (
    <span className={overdue ? "text-danger font-medium" : "text-op-muted"}>
      {formatDate(row.invoiceDueAt, { locale, timeStyle: undefined })}
      {overdue && <span className="block text-[11px]">{t("overdueLabel")}</span>}
    </span>
  );
}

function UnpaidRows({
  rows,
  money,
  locale,
  onOpenDetail,
  onPay,
  onEditInvoice,
}: RowProps & { onPay: (row: PurchaseListRow) => void; onEditInvoice: (row: PurchaseListRow) => void }) {
  const t = useTranslations("opErp");
  const poLabel = (r: PurchaseListRow) => t("poNumber", { number: padNumber(r.number) });
  const actions = (r: PurchaseListRow) => (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => onEditInvoice(r)}
        aria-label={t("plEditInvoiceFor", { number: poLabel(r) })}
        className="min-h-[36px] px-3 rounded-full text-[11px] font-medium text-op-muted hover:text-ink"
      >
        {t("editInvoice")}
      </button>
      <button
        type="button"
        onClick={() => onPay(r)}
        aria-label={t("plPayFor", { number: poLabel(r) })}
        className="mp-btn mp-btn--sm mp-btn--secondary"
      >
        {t("registerPayment")}
      </button>
    </span>
  );
  return (
    <>
      <div className="hidden @min-[56rem]:block overflow-hidden rounded-2xl border border-op-border bg-op-surface">
        <table className="w-full text-sm">
          <thead className="bg-op-bg">
            <tr>
              <Th>{t("plColPurchase")}</Th>
              <Th>{t("plColSupplier")}</Th>
              <Th>{t("plColInvoice")}</Th>
              <Th>{t("plColDue")}</Th>
              <Th align="right">{t("plColTotal")}</Th>
              <Th align="right">{t("plColBalance")}</Th>
              <Th align="right">
                <span className="sr-only">{t("plColActions")}</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-op-border transition-colors hover:bg-op-bg/50">
                <Td className="whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => onOpenDetail(r.id)}
                    className="font-medium underline-offset-2 hover:underline focus-visible:underline"
                    aria-label={t("plOpenPurchase", { number: poLabel(r) })}
                  >
                    {poLabel(r)}
                  </button>
                  {r.payStatus && (
                    <span className="mt-1 block">
                      <PayStatusChip status={r.payStatus} />
                    </span>
                  )}
                </Td>
                <Td className="w-full max-w-0">
                  <span className="block truncate" title={r.supplier.name}>
                    {r.supplier.name}
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  <InvoiceText row={r} />
                </Td>
                <Td className="whitespace-nowrap">
                  <DueText row={r} locale={locale} />
                </Td>
                <Td align="right" className="whitespace-nowrap tabular text-op-muted">
                  {money(r.receivedTotalCents)}
                  {r.paidCents > 0 && <span className="block text-[11px]">{t("plPaidValue", { amount: money(r.paidCents) })}</span>}
                  {r.receivedRetentionsCents > 0 && (
                    <span className="block text-[11px]">{t("poUnpaidRetained", { amount: money(r.receivedRetentionsCents) })}</span>
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap font-semibold tabular">
                  {money(r.outstandingCents)}
                </Td>
                <Td align="right" className="whitespace-nowrap">
                  {actions(r)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="@min-[56rem]:hidden overflow-hidden rounded-2xl border border-op-border bg-op-surface">
        {rows.map((r) => (
          <li key={r.id} className="px-4 py-2.5 border-b border-op-border last:border-b-0">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onOpenDetail(r.id)}
                className="flex-1 min-w-0 text-left"
                aria-label={t("plOpenPurchase", { number: poLabel(r) })}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium shrink-0">{poLabel(r)}</span>
                  <span className="text-sm text-op-muted truncate">{r.supplier.name}</span>
                  {r.payStatus && <PayStatusChip status={r.payStatus} />}
                </span>
                <span className="block text-[11px] mt-0.5 truncate">
                  <span className="text-op-muted">
                    {r.supplierInvoiceNumber ? t("invoiceLabel", { number: r.supplierInvoiceNumber }) : t("noInvoiceNumber")}
                  </span>
                  {r.invoiceDueAt && (
                    <span className={r.payStatus === "overdue" ? "text-danger font-medium" : "text-op-muted"}>
                      {" · "}
                      {t("dueLabel", { date: formatDate(r.invoiceDueAt, { locale, timeStyle: undefined }) })}
                    </span>
                  )}
                </span>
              </button>
              <span className="text-right shrink-0">
                <span className="block text-sm font-medium tabular">{money(r.outstandingCents)}</span>
                <span className="block text-[10px] text-op-muted tabular mt-0.5">
                  {t("cxpTotalPaid", { total: money(r.receivedTotalCents), paid: money(r.paidCents) })}
                </span>
              </span>
            </div>
            <div className="flex justify-end mt-1">{actions(r)}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

