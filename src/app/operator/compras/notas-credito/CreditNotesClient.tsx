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
  useListNavigation,
} from "@/components/billingCustomers/ListControls";
import {
  CREDIT_NOTE_STATUS_FILTERS,
  creditNoteListHref,
  hasCreditNoteFilters,
  type CreditNoteListPage,
  type CreditNoteListParams,
  type CreditNoteStatusFilter,
} from "@/lib/erp/supplierCreditNoteList";
import { KIND_LABEL_KEY, SUPPLIER_CREDIT_NOTE_KINDS, type SupplierCreditNoteKind } from "@/lib/erp/supplierCreditNotes";
import type { CreditNotePrefill } from "@/lib/erp/supplierCreditNoteAi";
import { CreditNoteForm } from "./CreditNoteForm";
import { CreditNoteDetail } from "./CreditNoteDetail";
import { KindChip } from "./KindChip";

export type SupplierRef = { id: string; name: string; taxId: string | null };

/** Lectura con IA lista para prellenar el formulario (de «Cargar factura» o de «Leer con IA»). */
export type InitialReading = {
  uploadId?: string | null;
  fileUrl: string;
  prefill: CreditNotePrefill & { supplierId: string | null; relatedPurchaseIds: string[] };
};

const STATUS_KEY: Record<CreditNoteStatusFilter, string> = {
  all: "statusAll",
  with_balance: "statusWithBalance",
  active: "statusActive",
  voided: "statusVoided",
};

export function CreditNotesClient({
  list,
  params,
  suppliers,
  filterSuppliers,
  currency,
  country,
  ivaDeductible,
  initialReading,
  initialDetailId,
}: {
  list: CreditNoteListPage;
  params: CreditNoteListParams;
  suppliers: SupplierRef[];
  filterSuppliers: SupplierRef[];
  currency: string;
  country: string | null;
  ivaDeductible: boolean;
  initialReading: InitialReading | null;
  initialDetailId: string | null;
}) {
  const t = useTranslations("opSupplierCredit");
  const locale = useLocale() as Locale;
  const nav = useListNavigation();
  const money = (c: number) => formatMoney(c, { currency, locale });
  const [form, setForm] = useState<{ reading: InitialReading | null } | null>(
    initialReading ? { reading: initialReading } : null,
  );
  const [detailId, setDetailId] = useState<string | null>(initialDetailId);
  const [filtersOpen, setFiltersOpen] = useState(
    Boolean(params.supplier || params.kind !== "all" || params.status !== "all" || params.from || params.to),
  );
  const hrefWith = (patch: Partial<CreditNoteListParams>) => creditNoteListHref({ ...params, page: 1, ...patch });
  const filtered = hasCreditNoteFilters(params);
  const from = list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1;
  const to = Math.min(list.total, list.page * list.pageSize);

  return (
    <section className="@container space-y-4" aria-label={t("tabCreditNotes")}>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setForm({ reading: null })} className="mp-btn mp-btn--primary">
          {t("newNote")}
        </button>
        <Link href="/operator/reportes/notas-credito-proveedores" className="mp-btn mp-btn--secondary">
          {t("openReport")}
        </Link>
      </div>

      {/* Resumen de lo filtrado (todas las páginas). */}
      <div className="grid grid-cols-2 @3xl:grid-cols-4 gap-2" aria-label={t("summaryLabel")}>
        <SummaryTile label={t("sumTotal")} value={money(list.summary.totalCents)} sub={t("notesCount", { n: list.summary.count })} />
        <SummaryTile label={t("balanceLabel")} value={money(list.summary.availableCents)} sub={t("sumBalanceSub")} strong />
        <SummaryTile label={t("kindAgreement")} value={money(list.summary.byKind.agreement)} />
        <SummaryTile
          label={t("sumOtherKinds")}
          value={money(list.summary.byKind.discount + list.summary.byKind.conditional_discount + list.summary.byKind.return)}
        />
      </div>
      {filtered && <p className="text-[11px] text-op-muted">{t("sumFilteredNote")}</p>}

      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 @4xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_11rem_11rem] @4xl:items-end">
        <SearchBox
          id="credit-notes-search"
          label={t("searchLabel")}
          placeholder={t("searchPlaceholder")}
          value={params.q}
          onSearch={(q) => nav.go(hrefWith({ q }), "replace")}
        />
        <div className="@4xl:hidden">
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            aria-controls="credit-notes-filters"
            className="mp-btn mp-btn--secondary h-11"
          >
            {t("filtersToggle")}
          </button>
        </div>
        <div
          id="credit-notes-filters"
          className={(filtersOpen ? "grid" : "hidden") + " col-span-2 @4xl:col-span-3 @4xl:grid grid-cols-1 @xl:grid-cols-3 gap-3"}
        >
          <div className="min-w-0">
            <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">{t("filterSupplier")}</div>
            <SupplierCombobox
              suppliers={filterSuppliers}
              value={params.supplier || null}
              onChange={(id) => nav.go(hrefWith({ supplier: id ?? "" }), "replace")}
              placeholder={t("filterAllSuppliers")}
            />
          </div>
          <SelectField<SupplierCreditNoteKind | "all">
            id="credit-notes-kind"
            label={t("filterKind")}
            value={params.kind}
            options={[
              { value: "all", label: t("filterAllKinds") },
              ...SUPPLIER_CREDIT_NOTE_KINDS.map((k) => ({ value: k, label: t(KIND_LABEL_KEY[k]) })),
            ]}
            onChange={(kind) => nav.go(hrefWith({ kind }), "replace")}
          />
          <SelectField<CreditNoteStatusFilter>
            id="credit-notes-status"
            label={t("filterStatus")}
            value={params.status}
            options={CREDIT_NOTE_STATUS_FILTERS.map((s) => ({ value: s, label: t(STATUS_KEY[s]) }))}
            onChange={(status) => nav.go(hrefWith({ status }), "replace")}
          />
        </div>
      </div>

      <div className={nav.pending ? "opacity-60 transition-opacity" : "transition-opacity"}>
        {list.rows.length === 0 ? (
          filtered ? (
            <EmptyState
              title={t("noMatches")}
              action={
                <Link href={creditNoteListHref({})} prefetch={false} className="mp-btn mp-btn--ghost mp-btn--sm">
                  {t("clearFilters")}
                </Link>
              }
            />
          ) : (
            <EmptyState title={t("emptyTitle")} body={t("emptyBody")} />
          )
        ) : (
          <>
            {/* Escritorio: tabla. */}
            <div className="hidden @3xl:block overflow-x-auto rounded-2xl border border-op-border bg-op-surface">
              <table className="w-full text-sm">
                <thead className="border-b border-op-border">
                  <tr>
                    <Th>{t("colDate")}</Th>
                    <Th>{t("colNumber")}</Th>
                    <Th>{t("colSupplier")}</Th>
                    <Th>{t("colKind")}</Th>
                    <Th align="right">{t("colTotal")}</Th>
                    <Th align="right">{t("colApplied")}</Th>
                    <Th align="right">{t("balanceLabel")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((r) => (
                    <tr
                      key={r.id}
                      className={
                        "border-b border-op-border/60 last:border-b-0 hover:bg-op-bg cursor-pointer" +
                        (r.status === "voided" ? " text-op-muted" : "")
                      }
                      onClick={() => setDetailId(r.id)}
                    >
                      <Td className="whitespace-nowrap">{formatDate(r.date, { locale, timeStyle: undefined })}</Td>
                      <Td>
                        <button type="button" onClick={() => setDetailId(r.id)} className="font-mono font-medium hover:underline">
                          {r.number}
                        </button>
                        {r.status === "voided" && (
                          <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-medium text-danger">
                            {t("voidedChip")}
                          </span>
                        )}
                      </Td>
                      <Td className="max-w-[16rem] truncate">{r.supplier.name}</Td>
                      <Td>
                        <KindChip kind={r.kind} />
                        {r.agreement && <div className="mt-0.5 text-[11px] text-op-muted truncate max-w-[14rem]">{r.agreement}</div>}
                      </Td>
                      <Td align="right" className="tabular-nums whitespace-nowrap">{money(r.totalCents)}</Td>
                      <Td align="right" className="tabular-nums whitespace-nowrap">{money(r.appliedCents + r.refundedCents)}</Td>
                      <Td align="right" className="tabular-nums whitespace-nowrap font-medium">
                        {r.availableCents > 0 ? money(r.availableCents) : "—"}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Celular: una fila compacta por nota. */}
            <div className="@3xl:hidden rounded-2xl border border-op-border bg-op-surface overflow-hidden">
              {list.rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setDetailId(r.id)}
                  className="w-full text-left px-4 py-3 border-b border-op-border last:border-b-0 hover:bg-op-bg"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-sm font-medium shrink-0">{r.number}</span>
                        <KindChip kind={r.kind} />
                      </div>
                      <div className="text-[12px] text-op-muted truncate mt-0.5">
                        {[r.supplier.name, formatDate(r.date, { locale, timeStyle: undefined })].join(" · ")}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={"text-sm font-medium tabular-nums" + (r.status === "voided" ? " line-through text-op-muted" : "")}>
                        {money(r.totalCents)}
                      </div>
                      {r.availableCents > 0 && (
                        <div className="text-[11px] text-op-muted tabular-nums">{t("balanceShort", { amount: money(r.availableCents) })}</div>
                      )}
                      {r.status === "voided" && <div className="text-[11px] text-danger">{t("voidedChip")}</div>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <ListPagination
              from={from}
              to={to}
              total={list.total}
              prevHref={list.page > 1 ? creditNoteListHref({ ...params, page: list.page - 1 }) : null}
              nextHref={to < list.total ? creditNoteListHref({ ...params, page: list.page + 1 }) : null}
            />
          </>
        )}
      </div>

      {detailId && (
        <CreditNoteDetail
          noteId={detailId}
          currency={currency}
          onClose={() => setDetailId(null)}
          onChanged={() => nav.refresh()}
        />
      )}

      {form && (
        <CreditNoteForm
          suppliers={suppliers}
          currency={currency}
          country={country}
          ivaDeductible={ivaDeductible}
          reading={form.reading}
          onClose={() => setForm(null)}
          onSaved={(id) => {
            setForm(null);
            nav.refresh();
            setDetailId(id);
          }}
        />
      )}
    </section>
  );
}

function SummaryTile({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-3 min-w-0">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted truncate">{label}</div>
      <div className={"mt-1 tabular-nums truncate " + (strong ? "text-lg font-semibold" : "text-lg")}>{value}</div>
      {sub && <div className="text-[11px] text-op-muted truncate">{sub}</div>}
    </div>
  );
}
