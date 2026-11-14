import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { todayIso } from "@/lib/erp/reports/period";
import {
  applySupplierReportView,
  formatSupplierDocument,
  nextSort,
  paginateSupplierRows,
  parseSupplierReportQuery,
  SUPPLIER_SORT_KEYS,
  supplierReportSearchParams,
  supplierReportTotals,
  type SupplierReportQuery,
  type SupplierReportRow,
  type SupplierSortKey,
} from "@/lib/erp/reports/supplierReport";
import { conditionLabel, monthLabel, periodLabel } from "@/lib/erp/reports/supplierReportLabels";
import { loadSupplierReportRows } from "@/lib/erp/reports/supplierReportQueries";
import { SUPPLIER_CREDIT_REPORT_PATH, supplierCreditReportQs } from "@/lib/erp/reports/supplierCreditReportParams";
import { firstParam, reportGate } from "../_components/gate";
import { fmtIsoDate } from "../_components/fmt";
import { PrintButton } from "../_components/PrintButton";
import { CardFacts, CardTotal, ReportCards, ReportTable } from "../_components/ReportCards";
import { EmptyNote, FilterField, ReportFilterForm, ReportShell, StatTile } from "../_components/ReportShell";
import { SplitDownload } from "../_components/SplitDownload";
import { PeriodFields } from "./PeriodFields";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const BASE = "/operator/reportes/proveedores";
const API = "/api/operator/reports/proveedores";
const TH = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
const NUM = "px-3 py-2 text-right font-mono tabular whitespace-nowrap";
const CONTROL = "w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";

/** Clave i18n del encabezado de cada columna ordenable. */
const COLUMN_KEY: Record<SupplierSortKey, string> = {
  proveedor: "colSupplier",
  nit: "colTaxId",
  condicion: "colCondition",
  promedio: "colAverage",
  total: "colTotal",
  facturas: "colInvoices",
  ultima: "colLastPurchase",
  saldo: "colPayable",
  acuerdos: "colAgreements",
};
const NUMERIC_COLUMNS = new Set<SupplierSortKey>(["promedio", "total", "facturas", "saldo", "acuerdos"]);

function qs(params: Record<string, string>): string {
  const s = new URLSearchParams(params).toString();
  return s ? `?${s}` : "";
}

/** URL de la pantalla para una query (y página) dada. */
function pageHref(q: SupplierReportQuery, page: number): string {
  return `${BASE}${qs(supplierReportSearchParams(q, { page }))}`;
}

/**
 * Informe de proveedores: por proveedor, documento (tipo, número y DV),
 * condición de pago, promedio de compras mensuales, total del período,
 * facturas, última compra y saldo por pagar. Cálculo en
 * `@/lib/erp/reports/supplierReport` (la definición del promedio va
 * también en pantalla y en el Excel).
 *
 * Vive en Reportes (categoría Comerciales, junto a Cartera) y abre con
 * Contabilidad O con Compras: un comercio con sólo Compras llega desde
 * Compras y Proveedores, y «volver» lo lleva a Compras. Los roles son los
 * de todo el panel (operador, admin de grupo o de plataforma; el layout
 * saca al resto).
 *
 * Todo vive en la URL (formulario GET y enlaces): búsqueda, condición,
 * período, base, gastos, orden y página. Se pagina en el servidor sobre
 * TODAS las filas ya calculadas (el orden por promedio exige calcularlas
 * todas); la descarga lleva todas las filas filtradas.
 */
export default async function SupplierReportPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tSettings, locale] = await Promise.all([
    getTranslations("opSupplierReport"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate(["purchasing", "accounting"]);
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const sp = await searchParams;
  const raw = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, firstParam(v)]));
  const today = todayIso();
  const query = parseSupplierReportQuery(raw, today);
  const all = await loadSupplierReportRows(gate.restaurantId, query, today);
  const rows = applySupplierReportView(all, query);
  const totals = supplierReportTotals(rows, query.period.months);
  const page = paginateSupplierRows(rows, query.page);

  const loc = locale as Locale;
  const accounting = gate.modules.includes("accounting");
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const period = periodLabel(query.period, loc);
  const basisText = query.basis === "total" ? t("basisTotal") : t("basisCost");
  const exportParams = supplierReportSearchParams(query, { page: 1 });
  const statementHref = (id: string) =>
    `/operator/reportes/cartera/proveedor/${encodeURIComponent(id)}?hasta=${today}`;

  const supplierName = (r: SupplierReportRow) => (
    <>
      {accounting ? (
        <Link href={statementHref(r.supplierId)} className="font-medium hover:underline break-words">
          {r.name}
        </Link>
      ) : (
        <span className="font-medium break-words">{r.name}</span>
      )}
      {!r.active && (
        <span className="ml-2 inline-flex rounded-full bg-op-bg px-2 py-0.5 text-[10px] uppercase tracking-wider text-op-muted">
          {t("inactive")}
        </span>
      )}
    </>
  );
  const lastPurchase = (r: SupplierReportRow) => (r.lastPurchase ? fmtIsoDate(r.lastPurchase, loc) : "—");
  // Lo recibido por acuerdos lleva al reporte de notas crédito de ese
  // proveedor, sólo acuerdos y en el mismo período (con Contabilidad).
  const agreementsHref = (id: string) =>
    `${SUPPLIER_CREDIT_REPORT_PATH}${supplierCreditReportQs({
      period: { desde: query.period.desde, hasta: query.period.hasta },
      supplierId: id,
      kind: "agreement",
    })}`;
  const agreements = (r: SupplierReportRow) =>
    accounting && r.agreementCents !== 0 ? (
      <Link href={agreementsHref(r.supplierId)} className="hover:underline">
        {money(r.agreementCents)}
      </Link>
    ) : (
      money(r.agreementCents)
    );

  const header = (key: SupplierSortKey) => {
    const active = query.sort === key;
    const next = nextSort(query, key);
    const label = t(COLUMN_KEY[key]);
    return (
      <th
        key={key}
        aria-sort={active ? (query.dir === "asc" ? "ascending" : "descending") : undefined}
        className={`${TH} ${NUMERIC_COLUMNS.has(key) ? "text-right" : "text-left"}`}
      >
        <Link
          href={pageHref({ ...query, ...next }, 1)}
          aria-label={t("sortBy", { column: label })}
          className={`inline-flex items-center gap-1 hover:text-op-text ${active ? "text-op-text" : ""}`}
        >
          {label}
          <span aria-hidden className={active ? "" : "opacity-30"}>
            {active && query.dir === "asc" ? "↑" : "↓"}
          </span>
        </Link>
      </th>
    );
  };

  return (
    <ReportShell
      title={t("title")}
      description={t("subtitle")}
      {...(accounting ? {} : { backHref: "/operator/compras", backLabel: t("backToPurchases") })}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("printTitle"),
        subtitle: t("printSubtitle", { period, months: query.period.months, basis: basisText }),
      }}
      filters={
        <ReportFilterForm>
          <FilterField label={t("filterSearch")}>
            <input
              type="search"
              name="q"
              defaultValue={query.q}
              placeholder={t("searchPlaceholder")}
              maxLength={80}
              className={CONTROL}
            />
          </FilterField>
          <PeriodFields
            preset={query.period.preset}
            fromMonth={query.period.fromMonth}
            toMonth={query.period.toMonth}
            maxMonth={today.slice(0, 7)}
          />
          <FilterField label={t("filterBasis")}>
            <select name="base" defaultValue={query.basis} className={CONTROL}>
              <option value="costo">{t("basisCost")}</option>
              <option value="total">{t("basisTotal")}</option>
            </select>
          </FilterField>
          {/* En el celular, de a dos por fila; en pantallas anchas, sueltos en la barra. */}
          <div className="grid grid-cols-2 gap-3 md:contents">
            <FilterField label={t("filterCondition")}>
              <select name="condicion" defaultValue={query.condition} className={CONTROL}>
                <option value="todas">{t("condAll")}</option>
                <option value="contado">{t("condCash")}</option>
                <option value="credito">{t("condCredit")}</option>
              </select>
            </FilterField>
            <FilterField label={t("filterInclude")}>
              <select name="gastos" defaultValue={query.includeExpenses ? "si" : "no"} className={CONTROL}>
                <option value="si">{t("includeAll")}</option>
                <option value="no">{t("includePurchases")}</option>
              </select>
            </FilterField>
          </div>
          {/* En el celular no hay encabezados que tocar: el orden se elige acá. */}
          <div className="grid grid-cols-2 gap-3 md:hidden">
            <FilterField label={t("filterSort")}>
              <select name="orden" defaultValue={query.sort} className={CONTROL}>
                {SUPPLIER_SORT_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {t(COLUMN_KEY[k])}
                  </option>
                ))}
              </select>
            </FilterField>
            <FilterField label={t("filterDir")}>
              <select name="dir" defaultValue={query.dir} className={CONTROL}>
                <option value="desc">{t("sortDesc")}</option>
                <option value="asc">{t("sortAsc")}</option>
              </select>
            </FilterField>
          </div>
        </ReportFilterForm>
      }
      actions={
        <>
          <SplitDownload
            main={{ href: `${API}${qs({ ...exportParams, format: "xlsx" })}`, label: t("downloadExcel") }}
            items={[{ label: t("downloadCsv"), href: `${API}${qs({ ...exportParams, format: "csv" })}` }]}
            moreLabel={t("downloadMore")}
          />
          <PrintButton />
        </>
      }
      statCols={4}
      stats={
        <>
          <StatTile
            label={t("statSuppliers")}
            value={
              <>
                {totals.suppliers}
                <span className="mt-0.5 block text-xs font-normal text-op-muted">
                  {t("statSuppliersNote", { n: totals.withPurchases })}
                </span>
              </>
            }
          />
          <StatTile
            label={t("statTotal")}
            value={
              <>
                {money(totals.totalCents)}
                <span className="mt-0.5 block text-xs font-normal text-op-muted">{period}</span>
              </>
            }
          />
          <StatTile
            label={t("statAverage")}
            value={
              <>
                {money(totals.averageCents)}
                <span className="mt-0.5 block text-xs font-normal text-op-muted">
                  {t("statAverageNote", { months: query.period.months })}
                </span>
              </>
            }
          />
          <StatTile label={t("statPayable")} value={money(totals.payableCents)} />
        </>
      }
      note={t("note")}
    >
      <div className="min-w-0 rounded-2xl border border-op-border bg-op-surface px-4 py-3 text-sm">
        <div className="text-[10px] uppercase tracking-wider text-op-muted">{t("definitionTitle")}</div>
        <p className="mt-1 break-words">
          {t("definitionBody", {
            from: monthLabel(query.period.fromMonth, loc),
            to: monthLabel(query.period.toMonth, loc),
            months: query.period.months,
          })}
        </p>
        <p className="mt-1 break-words text-op-muted">
          {query.basis === "total" ? t("definitionTotal") : t("definitionCost")}{" "}
          {query.includeExpenses ? t("definitionAll") : t("definitionPurchases")}
        </p>
        <p className="mt-1 break-words text-op-muted">{t("definitionAgreements")}</p>
        {query.period.includesCurrentMonth && (
          <p className="mt-2 break-words text-danger">{t("currentMonthWarning")}</p>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyNote>{all.length === 0 && !query.q ? t("emptyNone") : t("empty")}</EmptyNote>
      ) : (
        <section className="min-w-0 space-y-2">
          {page.pages > 1 && (
            <div className="text-sm text-op-muted">
              {t("showing", { from: page.from, to: page.to, total: page.total })}
            </div>
          )}
          <div className="min-w-0 overflow-hidden rounded-2xl border border-op-border bg-op-surface">
            <ReportTable>
              <table className="w-full text-sm min-w-[980px]">
                <thead>
                  <tr className="border-b border-op-border text-op-muted">
                    {SUPPLIER_SORT_KEYS.map(header)}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((r) => (
                    <tr key={r.supplierId} className="border-b border-op-border/60 last:border-b-0">
                      <td className="px-3 py-2 min-w-0">{supplierName(r)}</td>
                      <td className="px-3 py-2 font-mono text-xs text-op-muted whitespace-nowrap">
                        {formatSupplierDocument(r.document) || "—"}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{conditionLabel(t, r.creditDays)}</td>
                      <td className={`${NUM} font-semibold`}>{money(r.averageCents)}</td>
                      <td className={NUM}>{money(r.totalCents)}</td>
                      <td className={NUM}>{r.invoices}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{lastPurchase(r)}</td>
                      <td className={NUM}>{money(r.payableCents)}</td>
                      <td className={NUM}>{agreements(r)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                    <td className="px-3 py-2" colSpan={3}>
                      {t("totalRow", { n: totals.suppliers })}
                    </td>
                    <td className={NUM}>{money(totals.averageCents)}</td>
                    <td className={NUM}>{money(totals.totalCents)}</td>
                    <td className={NUM}>{totals.invoices}</td>
                    <td />
                    <td className={NUM}>{money(totals.payableCents)}</td>
                    <td className={NUM}>{money(totals.agreementCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </ReportTable>
            <ReportCards>
              {page.rows.map((r) => (
                <div key={r.supplierId} className="px-3 py-2.5">
                  <div className="min-w-0">{supplierName(r)}</div>
                  <div className="font-mono text-xs text-op-muted break-words">
                    {formatSupplierDocument(r.document) || "—"} · {conditionLabel(t, r.creditDays)}
                  </div>
                  <CardFacts
                    className="mt-1.5"
                    items={[
                      { label: t("colAverage"), value: money(r.averageCents), strong: true },
                      { label: t("colTotal"), value: money(r.totalCents) },
                      { label: t("colInvoices"), value: r.invoices },
                      { label: t("colLastPurchase"), value: lastPurchase(r) },
                      { label: t("colPayable"), value: money(r.payableCents) },
                      { label: t("colAgreements"), value: agreements(r) },
                    ]}
                  />
                </div>
              ))}
              <CardTotal
                label={t("totalRow", { n: totals.suppliers })}
                items={[
                  { label: t("colAverage"), value: money(totals.averageCents) },
                  { label: t("colTotal"), value: money(totals.totalCents) },
                  { label: t("colInvoices"), value: totals.invoices },
                  { label: t("colPayable"), value: money(totals.payableCents) },
                  { label: t("colAgreements"), value: money(totals.agreementCents) },
                ]}
              />
            </ReportCards>
          </div>
          {page.pages > 1 && (
            <nav aria-label={t("paginationLabel")} className="no-print flex flex-wrap items-center justify-between gap-2">
              {page.page > 1 ? (
                <Link href={pageHref(query, page.page - 1)} className="mp-btn mp-btn--ghost mp-btn--sm" rel="prev">
                  ← {t("pagePrev")}
                </Link>
              ) : (
                <span />
              )}
              <span className="text-sm text-op-muted">{t("pageLabel", { page: page.page, pages: page.pages })}</span>
              {page.page < page.pages ? (
                <Link href={pageHref(query, page.page + 1)} className="mp-btn mp-btn--ghost mp-btn--sm" rel="next">
                  {t("pageNext")} →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </section>
      )}
    </ReportShell>
  );
}
