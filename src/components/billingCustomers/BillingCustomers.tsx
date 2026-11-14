"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import {
  CREDIT_STATUS_FILTERS,
  CUSTOMER_STATUS_FILTERS,
  CUSTOMERS_PATH,
  customerListHref,
  hasCustomerFilters,
  isCompany,
  type CustomerListParams,
  type CustomerSort,
  type CustomerStatusFilter,
  type CustomerTypeFilter,
} from "@/lib/billingCustomerList";
import type { BillingCustomerListPage, BillingCustomerListRow } from "@/lib/billingCustomerListQueries";
import { CustomerFormSheet } from "./CustomerFormSheet";
import { CreditPaymentSheet } from "./CreditPaymentSheet";
import { CreditStatementSheet } from "./CreditStatementSheet";
import {
  CustomersHeader,
  EmptyState,
  ListPagination,
  SearchBox,
  SegmentedFilter,
  SelectField,
  Td,
  Th,
  useListNavigation,
} from "./ListControls";
import { billingDocument, creditAvailableCents, discountBpsToPctText } from "./types";

/**
 * Clientes de facturación de /operator/clientes.
 *
 * La lista llega del servidor ya buscada, filtrada, ordenada y paginada
 * (`loadBillingCustomerPage`, sobre TODOS los clientes del comercio); este
 * componente sólo pinta y navega: cada filtro es un cambio de URL. Arriba,
 * si el comercio vende a crédito, el resumen de la lista filtrada (clientes,
 * con crédito, deuda total y vencida), que también sirve de atajo de filtro.
 * En el escritorio va en tabla; en el celular, en tarjetas compactas.
 *
 * Las acciones de siempre siguen acá: crear y editar (en una hoja), abonar
 * y ver el estado de cuenta. Después de guardar se vuelve a pedir la página
 * al servidor para que deuda y totales queden al día.
 */
export function BillingCustomers({
  list,
  params,
  currency = "COP",
  tabs,
}: {
  list: BillingCustomerListPage;
  params: CustomerListParams;
  currency?: string;
  tabs: ReactNode;
}) {
  const t = useTranslations("billingCustomers");
  const tPage = useTranslations("opCustomers");
  const locale = useLocale() as Locale;
  const money = useCallback((cents: number) => formatMoney(cents, { currency, locale }), [currency, locale]);
  const nav = useListNavigation();
  const [editing, setEditing] = useState<BillingCustomerListRow | null | undefined>(undefined);
  const [paying, setPaying] = useState<BillingCustomerListRow | null>(null);
  const [statement, setStatement] = useState<BillingCustomerListRow | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const filtered = hasCustomerFilters(params);
  const hrefWith = (patch: Partial<CustomerListParams>) => customerListHref({ ...params, page: 1, ...patch });
  const closeEditor = useCallback(() => setEditing(undefined), []);
  const openEditor = (customer: BillingCustomerListRow | null) => {
    setNotice("");
    setEditing(customer);
  };

  const typeOptions: { value: CustomerTypeFilter; label: string }[] = [
    { value: "all", label: t("typeAll") },
    { value: "company", label: t("typeCompany") },
    { value: "person", label: t("typePerson") },
  ];
  const STATUS_LABEL: Record<CustomerStatusFilter, string> = {
    all: t("statusAll"),
    credit: t("statusCredit"),
    debt: t("statusDebt"),
    overdue: t("statusOverdue"),
    discount: t("statusDiscount"),
  };
  const statusOptions = CUSTOMER_STATUS_FILTERS.filter(
    (s) => list.usesCredit || !CREDIT_STATUS_FILTERS.includes(s) || s === params.status,
  ).map((value) => ({ value, label: STATUS_LABEL[value] }));
  const sortOptions: { value: CustomerSort; label: string }[] = [
    { value: "name", label: t("sortName") },
    ...(list.usesCredit || params.sort === "debt" ? [{ value: "debt" as const, label: t("sortDebt") }] : []),
    { value: "recent", label: t("sortRecent") },
  ];

  const createButton = (
    <button type="button" onClick={() => openEditor(null)} className="mp-btn mp-btn--primary">
      <svg aria-hidden viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 5v14M5 12h14" />
      </svg>
      {t("create")}
    </button>
  );
  const clearLink = (
    <Link href={CUSTOMERS_PATH} prefetch={false} scroll={false} className="mp-btn mp-btn--ghost mp-btn--sm">
      {t("clearFilters")}
    </Link>
  );

  return (
    <>
      <CustomersHeader title={tPage("title")} subtitle={tPage("subtitle")} action={createButton} />
      {tabs}
      <section aria-labelledby="billing-customers-title" className="@container">
        <h2 id="billing-customers-title" className="sr-only">
          {t("title")}
        </h2>

        {notice && (
          <p role="status" className="mb-4 rounded-xl border border-ok/25 bg-ok/10 px-4 py-2.5 text-sm text-[color-mix(in_srgb,var(--ok)_80%,var(--op-text))]">
            {notice}
          </p>
        )}

        {list.allCount === 0 ? (
          // Sin acción propia: "Crear cliente" ya está en el encabezado (una sola acción principal).
          <EmptyState title={t("emptyTitle")} body={t("empty")} />
        ) : (
          <>
            {list.usesCredit && <SummaryStrip list={list} params={params} money={money} filtered={filtered} />}

            <div className="mb-3 flex flex-col gap-3 @5xl:flex-row @5xl:items-end">
              <div className="min-w-0 @5xl:flex-1">
                <div aria-hidden className="hidden @5xl:block font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                  {t("searchShort")}
                </div>
                <SearchBox
                  id="billing-customers-search"
                  label={t("search")}
                  placeholder={t("searchPlaceholder")}
                  value={params.q}
                  onSearch={(q) => nav.go(hrefWith({ q }), "replace")}
                />
              </div>
              <div className="grid grid-cols-2 gap-3 @xl:flex @xl:items-end">
                <div className="col-span-2 @xl:col-span-1">
                  <SegmentedFilter label={t("filterType")} value={params.type} options={typeOptions} onChange={(type) => nav.go(hrefWith({ type }))} />
                </div>
                <SelectField
                  id="billing-customers-status"
                  label={t("filterStatus")}
                  value={params.status}
                  options={statusOptions}
                  onChange={(status) => nav.go(hrefWith({ status }))}
                  className="@xl:w-44"
                />
                <SelectField
                  id="billing-customers-sort"
                  label={t("sortLabel")}
                  value={params.sort}
                  options={sortOptions}
                  onChange={(sort) => nav.go(hrefWith({ sort }))}
                  className="@xl:w-44"
                />
              </div>
            </div>

            <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-op-muted tabular" aria-live="polite">
                {filtered ? t("resultCountFiltered", { count: list.total, all: list.allCount }) : t("resultCount", { count: list.total })}
              </span>
              {filtered && list.rows.length > 0 && clearLink}
            </div>

            <div aria-busy={nav.pending} className={`transition-opacity duration-150 ${nav.pending ? "opacity-55" : ""}`}>
              {list.rows.length === 0 ? (
                <EmptyState title={t("noMatches")} body={t("noMatchesHint")} action={clearLink} />
              ) : (
                <>
                  <CustomerTable
                    rows={list.rows}
                    usesCredit={list.usesCredit}
                    money={money}
                    onEdit={openEditor}
                    onPay={(c) => {
                      setNotice("");
                      setPaying(c);
                    }}
                    onStatement={setStatement}
                  />
                  <CustomerCards
                    rows={list.rows}
                    money={money}
                    onEdit={openEditor}
                    onPay={(c) => {
                      setNotice("");
                      setPaying(c);
                    }}
                    onStatement={setStatement}
                  />
                </>
              )}
              <ListPagination
                from={list.from}
                to={list.to}
                total={list.total}
                prevHref={list.page > 1 ? customerListHref({ ...params, page: list.page - 1 }) : null}
                nextHref={list.page < list.pageCount ? customerListHref({ ...params, page: list.page + 1 }) : null}
              />
            </div>
          </>
        )}
      </section>

      {editing !== undefined && (
        <CustomerFormSheet
          initial={editing}
          onClose={closeEditor}
          onSaved={() => {
            setNotice(t(editing ? "updated" : "created"));
            setEditing(undefined);
            nav.refresh();
          }}
        />
      )}
      {paying && (
        <CreditPaymentSheet
          customer={paying}
          currency={currency}
          onClose={() => setPaying(null)}
          onSaved={(debtAfter) => {
            setPaying(null);
            setNotice(t("abonoSaved", { amount: money(debtAfter) }));
            nav.refresh();
          }}
        />
      )}
      {statement && (
        <CreditStatementSheet customer={statement} currency={currency} onClose={() => setStatement(null)} onChanged={nav.refresh} />
      )}
    </>
  );
}

// ── Resumen ───────────────────────────────────────────────────────────────

function SummaryStrip({
  list,
  params,
  money,
  filtered,
}: {
  list: BillingCustomerListPage;
  params: CustomerListParams;
  money: (cents: number) => string;
  filtered: boolean;
}) {
  const t = useTranslations("billingCustomers");
  const s = list.summary;
  const tile = (status: CustomerStatusFilter) =>
    customerListHref({ ...params, page: 1, status: params.status === status ? "all" : status });
  return (
    <section aria-label={t("summaryLabel")} className="mb-5">
      <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4 @3xl:gap-3">
        <SummaryTile label={t("sumClients")} value={String(s.count)} sub={filtered ? t("sumOfAll", { all: list.allCount }) : t("sumAllClients")} />
        <SummaryTile
          label={t("sumCredit")}
          value={String(s.creditCount)}
          sub={t("sumCreditSub")}
          href={tile("credit")}
          active={params.status === "credit"}
        />
        <SummaryTile
          label={t("sumDebt")}
          value={money(s.debtCents)}
          sub={t("sumDebtors", { count: s.debtorCount })}
          href={tile("debt")}
          active={params.status === "debt"}
          tone={s.debtCents > 0 ? "accent" : undefined}
        />
        <SummaryTile
          label={t("sumOverdue")}
          value={money(s.overdueCents)}
          sub={t("sumOverdueCount", { count: s.overdueCount })}
          href={tile("overdue")}
          active={params.status === "overdue"}
          tone={s.overdueCents > 0 ? "danger" : undefined}
        />
      </div>
      {filtered && <p className="mt-2 text-[11px] text-op-muted">{t("sumFilteredNote")}</p>}
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
      <span className={`mt-0.5 block font-semibold tabular text-lg @3xl:mt-1 @3xl:text-2xl break-words ${tone ? TONE_TEXT[tone] : ""}`}>{value}</span>
      {/* En el celular la tarjeta queda en etiqueta + cifra: la lista sube. */}
      <span className="mt-0.5 hidden text-xs text-op-muted @xl:block">{sub}</span>
    </>
  );
  const base = "block min-w-0 rounded-2xl border bg-op-surface px-3.5 py-2.5 @3xl:px-4 @3xl:py-3";
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

// ── Filas ─────────────────────────────────────────────────────────────────

type RowActions = {
  money: (cents: number) => string;
  onEdit: (c: BillingCustomerListRow) => void;
  onPay: (c: BillingCustomerListRow) => void;
  onStatement: (c: BillingCustomerListRow) => void;
};

/** El cliente tiene algo de crédito que mostrar (habilitado o con deuda). */
function showsCredit(c: BillingCustomerListRow): boolean {
  return c.creditEnabled || c.debtCents !== 0;
}

function Badges({ customer }: { customer: BillingCustomerListRow }) {
  const t = useTranslations("billingCustomers");
  const discount = customer.discountEnabled && customer.discountBps > 0;
  if (!customer.creditEnabled && !discount) return null;
  return (
    <span className="mt-1.5 flex flex-wrap gap-1.5">
      {customer.creditEnabled && (
        <span className="inline-flex items-center rounded-full border border-op-border bg-op-bg px-2 py-0.5 text-[11px] text-op-muted">
          {t("creditBadge")}
        </span>
      )}
      {discount && (
        <span className="inline-flex items-center rounded-full border border-ok/25 bg-ok/10 px-2 py-0.5 text-[11px] text-[color-mix(in_srgb,var(--ok)_80%,var(--op-text))]">
          {t("discountBadge", { pct: discountBpsToPctText(customer.discountBps) })}
        </span>
      )}
    </span>
  );
}

function DocumentCell({ customer }: { customer: BillingCustomerListRow }) {
  return (
    <span className="font-mono text-[13px] whitespace-nowrap">
      <span className="text-op-muted text-[11px] mr-1.5">{customer.docType}</span>
      {billingDocument(customer)}
    </span>
  );
}

function DebtAmount({ customer, money, size = "base" }: { customer: BillingCustomerListRow; money: (c: number) => string; size?: "base" | "lg" }) {
  const t = useTranslations("billingCustomers");
  const debt = customer.debtCents;
  return (
    <>
      <span className={`block font-semibold tabular ${size === "lg" ? "text-lg" : "text-[15px]"} ${debt > 0 ? "text-op-accent" : "text-op-muted font-normal"}`}>
        {debt > 0 ? money(debt) : t("noDebt")}
      </span>
      {customer.overdueCents > 0 && (
        <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-[color-mix(in_srgb,var(--danger)_85%,var(--op-text))]">
          <svg aria-hidden viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          {t("overdueValue", { amount: money(customer.overdueCents) })}
        </span>
      )}
    </>
  );
}

function CustomerTable({ rows, usesCredit, money, onEdit, onPay, onStatement }: RowActions & { rows: BillingCustomerListRow[]; usesCredit: boolean }) {
  const t = useTranslations("billingCustomers");
  return (
    <div className="hidden @min-[56rem]:block overflow-hidden rounded-2xl border border-op-border bg-op-surface">
      <table className="w-full text-sm">
        <thead className="bg-op-bg">
          <tr>
            <Th>{t("colCustomer")}</Th>
            <Th className="hidden @min-[66rem]:table-cell">{t("colDocument")}</Th>
            <Th>{t("colContact")}</Th>
            {usesCredit && <Th>{t("colCredit")}</Th>}
            {usesCredit && <Th align="right">{t("colDebt")}</Th>}
            <Th align="right">
              <span className="sr-only">{t("colActions")}</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const available = creditAvailableCents(c);
            return (
              <tr key={c.id} className="border-t border-op-border transition-colors hover:bg-op-bg/50">
                <Td className="min-w-[11rem] max-w-[15rem]">
                  <span className="block font-medium break-words">{c.customerName}</span>
                  <span className="block whitespace-nowrap text-xs text-op-muted">
                    {/* Sin espacio para su columna, el documento va bajo el nombre. */}
                    <span className="@min-[66rem]:hidden">
                      <DocumentCell customer={c} />
                      <span aria-hidden>{" · "}</span>
                    </span>
                    {t(isCompany(c.docType) ? "kindCompany" : "kindPerson")}
                  </span>
                  <Badges customer={c} />
                </Td>
                <Td className="hidden @min-[66rem]:table-cell">
                  <DocumentCell customer={c} />
                </Td>
                <Td className="w-full max-w-0">
                  <span className="block truncate" title={[c.email, ...(c.ccEmails ?? [])].join(", ")}>
                    {c.email}
                  </span>
                  {(c.ccEmails?.length ?? 0) > 0 && <span className="block text-xs text-op-muted mt-0.5">{t("moreEmails", { count: c.ccEmails?.length ?? 0 })}</span>}
                  {c.phone && <span className="block text-xs text-op-muted mt-0.5">{c.phone}</span>}
                </Td>
                {usesCredit && (
                  <Td className="whitespace-nowrap">
                    {c.creditEnabled ? (
                      <>
                        <span className="block">{c.creditLimitCents != null ? t("creditLimitValue", { amount: money(c.creditLimitCents) }) : t("creditNoLimit")}</span>
                        <span className="block text-xs text-op-muted">{t("creditTerms", { days: c.creditTermsDays })}</span>
                        {available != null && <span className="block text-xs text-op-muted">{t("availableValue", { amount: money(available) })}</span>}
                      </>
                    ) : (
                      <span className="text-op-muted">
                        <span aria-hidden>{"—"}</span>
                        <span className="sr-only">{t("creditOff")}</span>
                      </span>
                    )}
                  </Td>
                )}
                {usesCredit && (
                  <Td align="right" className="whitespace-nowrap">
                    {showsCredit(c) ? (
                      <>
                        <DebtAmount customer={c} money={money} />
                        <button
                          type="button"
                          onClick={() => onStatement(c)}
                          aria-label={t("statementFor", { name: c.customerName })}
                          className="mt-1 block ml-auto text-xs font-medium text-op-muted underline underline-offset-2 hover:text-op-text"
                        >
                          {t("statement")}
                        </button>
                      </>
                    ) : (
                      <span className="text-op-muted">{"—"}</span>
                    )}
                  </Td>
                )}
                <Td align="right" className="whitespace-nowrap">
                  <span className="inline-flex gap-2">
                    {c.debtCents > 0 && (
                      <button type="button" onClick={() => onPay(c)} aria-label={t("addPaymentFor", { name: c.customerName })} className="mp-btn mp-btn--primary mp-btn--sm">
                        {t("addPayment")}
                      </button>
                    )}
                    <button type="button" onClick={() => onEdit(c)} aria-label={t("editCustomer", { name: c.customerName })} className="mp-btn mp-btn--secondary mp-btn--sm">
                      {t("edit")}
                    </button>
                  </span>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CustomerCards({ rows, money, onEdit, onPay, onStatement }: RowActions & { rows: BillingCustomerListRow[] }) {
  const t = useTranslations("billingCustomers");
  return (
    <ul className="@min-[56rem]:hidden grid grid-cols-1 gap-2 @2xl:grid-cols-2">
      {rows.map((c) => (
        <li key={c.id} className="flex flex-col rounded-2xl border border-op-border bg-op-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-medium break-words leading-snug">{c.customerName}</h3>
              <p className="mt-0.5 text-xs text-op-muted">
                <DocumentCell customer={c} />
                <span aria-hidden>{" · "}</span>
                {t(isCompany(c.docType) ? "kindCompany" : "kindPerson")}
              </p>
              <p className="mt-0.5 text-xs text-op-muted break-all">{c.email}</p>
              {(c.ccEmails?.length ?? 0) > 0 && <p className="text-xs text-op-muted">{t("moreEmails", { count: c.ccEmails?.length ?? 0 })}</p>}
              {c.phone && <p className="text-xs text-op-muted">{c.phone}</p>}
              <Badges customer={c} />
            </div>
            <button type="button" onClick={() => onEdit(c)} aria-label={t("editCustomer", { name: c.customerName })} className="mp-btn mp-btn--secondary mp-btn--sm shrink-0">
              {t("edit")}
            </button>
          </div>
          {showsCredit(c) && (
            <div className="mt-auto">
              <div className="mt-3 flex flex-wrap items-end justify-between gap-x-3 gap-y-2 border-t border-op-border pt-3">
              <div className="min-w-0">
                <span className="block font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">{t("debt")}</span>
                <DebtAmount customer={c} money={money} size="lg" />
              </div>
              <span className="ml-auto flex gap-2">
                <button type="button" onClick={() => onStatement(c)} aria-label={t("statementFor", { name: c.customerName })} className="mp-btn mp-btn--ghost mp-btn--sm">
                  {t("statement")}
                </button>
                {c.debtCents > 0 && (
                  <button type="button" onClick={() => onPay(c)} aria-label={t("addPaymentFor", { name: c.customerName })} className="mp-btn mp-btn--primary mp-btn--sm">
                    {t("addPayment")}
                  </button>
                )}
              </span>
              </div>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
