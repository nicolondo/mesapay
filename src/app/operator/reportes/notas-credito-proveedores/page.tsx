import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { creditNoteListHref } from "@/lib/erp/supplierCreditNoteList";
import { KIND_LABEL_KEY, SUPPLIER_CREDIT_NOTE_KINDS } from "@/lib/erp/supplierCreditNotes";
import { todayIso } from "@/lib/erp/reports/period";
import { loadCreditNoteSuppliers, loadSupplierCreditReport } from "@/lib/erp/reports/supplierCreditReportQueries";
import {
  parseSupplierCreditReportQuery,
  SUPPLIER_CREDIT_REPORT_API,
  supplierCreditReportQs,
} from "@/lib/erp/reports/supplierCreditReportParams";
import { firstParam, reportGate } from "../_components/gate";
import { fmtIsoDate } from "../_components/fmt";
import { PrintButton } from "../_components/PrintButton";
import { CardFacts, CardTotal, ReportCards, ReportScroll, ReportTable } from "../_components/ReportCards";
import { ReportPeriod } from "../_components/ReportPeriod";
import { EmptyNote, FilterField, ReportFilterForm, ReportShell, StatTile } from "../_components/ReportShell";
import { SplitDownload } from "../_components/SplitDownload";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TH = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
const TD = "px-3 py-2";
const NUM = "px-3 py-2 text-right font-mono tabular whitespace-nowrap";
const CONTROL = "w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";

/**
 * Notas crédito de proveedores: cuánto se recibió en el período por
 * acuerdos comerciales, descuentos, pronto pago y devoluciones; por
 * proveedor, por acuerdo y por mes, con el detalle. Excel (con chevron para
 * el CSV) e impresión. En el celular las tablas de resumen salen como
 * tarjetas; el detalle se desplaza dentro de su tarjeta.
 */
export default async function SupplierCreditReportPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tSettings, locale] = await Promise.all([
    getTranslations("opSupplierCredit"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const sp = await searchParams;
  const query = parseSupplierCreditReportQuery(
    {
      desde: firstParam(sp.desde),
      hasta: firstParam(sp.hasta),
      proveedor: firstParam(sp.proveedor),
      tipo: firstParam(sp.tipo),
    },
    todayIso(),
  );
  const [report, suppliers] = await Promise.all([
    loadSupplierCreditReport(gate.restaurantId, query.period, query),
    loadCreditNoteSuppliers(gate.restaurantId),
  ]);

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const periodVars = { desde: fmtIsoDate(query.period.desde, loc), hasta: fmtIsoDate(query.period.hasta, loc) };
  const kindTotal = (k: (typeof SUPPLIER_CREDIT_NOTE_KINDS)[number]) =>
    report.byKind.find((x) => x.kind === k)?.totalCents ?? 0;
  const monthLabel = (m: string) =>
    new Intl.DateTimeFormat(loc, { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T12:00:00Z`));

  return (
    <ReportShell
      title={t("reportTitle")}
      description={t("reportSubtitle", periodVars)}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("reportTitle"),
        subtitle: t("reportSubtitle", periodVars),
      }}
      filters={
        <ReportFilterForm>
          <ReportPeriod key={`${query.period.desde}-${query.period.hasta}`} desde={query.period.desde} hasta={query.period.hasta} step="mes" />
          <FilterField label={t("filterSupplier")}>
            <select name="proveedor" defaultValue={query.supplierId ?? ""} className={CONTROL}>
              <option value="">{t("filterAllSuppliers")}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label={t("filterKind")}>
            <select name="tipo" defaultValue={query.kind ?? ""} className={CONTROL}>
              <option value="">{t("filterAllKinds")}</option>
              {SUPPLIER_CREDIT_NOTE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(KIND_LABEL_KEY[k])}
                </option>
              ))}
            </select>
          </FilterField>
        </ReportFilterForm>
      }
      actions={
        <>
          <SplitDownload
            main={{ href: `${SUPPLIER_CREDIT_REPORT_API}${supplierCreditReportQs(query, { format: "xlsx" })}`, label: t("downloadExcel") }}
            items={[{ label: t("downloadCsv"), href: `${SUPPLIER_CREDIT_REPORT_API}${supplierCreditReportQs(query, { format: "csv" })}` }]}
            moreLabel={t("downloadMore")}
          />
          <PrintButton />
        </>
      }
      statCols={4}
      stats={
        <>
          <StatTile
            label={t("statReceived")}
            value={
              <>
                {money(report.totals.totalCents)}
                <span className="mt-0.5 block text-xs font-normal text-op-muted">{t("notesCount", { n: report.totals.count })}</span>
              </>
            }
          />
          <StatTile label={t("kindAgreement")} value={money(kindTotal("agreement"))} />
          <StatTile label={t("kindDiscount")} value={money(kindTotal("discount") + kindTotal("conditional_discount"))} />
          <StatTile label={t("kindReturn")} value={money(kindTotal("return"))} />
        </>
      }
      note={t("reportNote")}
    >
      {report.totals.count === 0 ? (
        <EmptyNote>{t("reportEmpty")}</EmptyNote>
      ) : (
        <>
          <Section title={t("byKindTitle")}>
            <ReportTable>
              <table className="w-full text-sm min-w-[560px]">
                <thead>
                  <tr className="border-b border-op-border text-op-muted">
                    <th className={`${TH} text-left`}>{t("colKind")}</th>
                    <th className={`${TH} text-right`}>{t("colCount")}</th>
                    <th className={`${TH} text-right`}>{t("colBase")}</th>
                    <th className={`${TH} text-right`}>{t("colIva")}</th>
                    <th className={`${TH} text-right`}>{t("colTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byKind.map((k) => (
                    <tr key={k.kind} className="border-b border-op-border/60 last:border-b-0">
                      <td className={TD}>{t(KIND_LABEL_KEY[k.kind])}</td>
                      <td className={NUM}>{k.count}</td>
                      <td className={NUM}>{money(k.baseCents)}</td>
                      <td className={NUM}>{money(k.ivaCents)}</td>
                      <td className={`${NUM} font-semibold`}>{money(k.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                    <td className={TD}>{t("totalLabel")}</td>
                    <td className={NUM}>{report.totals.count}</td>
                    <td className={NUM}>{money(report.totals.baseCents)}</td>
                    <td className={NUM}>{money(report.totals.ivaCents)}</td>
                    <td className={NUM}>{money(report.totals.totalCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </ReportTable>
            <ReportCards>
              {report.byKind.map((k) => (
                <div key={k.kind} className="px-3 py-2.5">
                  <div className="font-medium">{t(KIND_LABEL_KEY[k.kind])}</div>
                  <CardFacts
                    className="mt-1.5"
                    items={[
                      { label: t("colCount"), value: k.count },
                      { label: t("colTotal"), value: money(k.totalCents), strong: true },
                    ]}
                  />
                </div>
              ))}
              <CardTotal label={t("totalLabel")} items={[{ label: t("colTotal"), value: money(report.totals.totalCents) }]} />
            </ReportCards>
          </Section>

          {report.byAgreement.length > 0 && (
            <Section title={t("byAgreementTitle")}>
              <ReportTable>
                <table className="w-full text-sm min-w-[560px]">
                  <thead>
                    <tr className="border-b border-op-border text-op-muted">
                      <th className={`${TH} text-left`}>{t("colAgreement")}</th>
                      <th className={`${TH} text-left`}>{t("colSupplier")}</th>
                      <th className={`${TH} text-right`}>{t("colCount")}</th>
                      <th className={`${TH} text-right`}>{t("colTotal")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.byAgreement.map((a) => (
                      <tr key={a.key} className="border-b border-op-border/60 last:border-b-0">
                        <td className={TD}>{a.agreement ?? <span className="text-op-muted">{t("noAgreement")}</span>}</td>
                        <td className={TD}>{a.supplierName}</td>
                        <td className={NUM}>{a.count}</td>
                        <td className={`${NUM} font-semibold`}>{money(a.totalCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ReportTable>
              <ReportCards>
                {report.byAgreement.map((a) => (
                  <div key={a.key} className="px-3 py-2.5">
                    <div className="font-medium break-words">{a.agreement ?? t("noAgreement")}</div>
                    <div className="text-xs text-op-muted">{a.supplierName}</div>
                    <CardFacts
                      className="mt-1.5"
                      items={[
                        { label: t("colCount"), value: a.count },
                        { label: t("colTotal"), value: money(a.totalCents), strong: true },
                      ]}
                    />
                  </div>
                ))}
              </ReportCards>
            </Section>
          )}

          <Section title={t("bySupplierTitle")}>
            <ReportScroll>
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr className="border-b border-op-border text-op-muted">
                    <th className={`${TH} text-left`}>{t("colSupplier")}</th>
                    {SUPPLIER_CREDIT_NOTE_KINDS.map((k) => (
                      <th key={k} className={`${TH} text-right`}>
                        {t(KIND_LABEL_KEY[k])}
                      </th>
                    ))}
                    <th className={`${TH} text-right`}>{t("colTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.bySupplier.map((s) => (
                    <tr key={s.supplierId} className="border-b border-op-border/60 last:border-b-0">
                      <td className={TD}>
                        <Link href={creditNoteListHref({ supplier: s.supplierId, from: query.period.desde, to: query.period.hasta })} className="font-medium hover:underline">
                          {s.name}
                        </Link>
                        {s.taxId && <div className="font-mono text-xs text-op-muted">{s.taxId}</div>}
                      </td>
                      {SUPPLIER_CREDIT_NOTE_KINDS.map((k) => (
                        <td key={k} className={NUM}>
                          {s.byKind[k] ? money(s.byKind[k]) : "—"}
                        </td>
                      ))}
                      <td className={`${NUM} font-semibold`}>{money(s.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ReportScroll>
          </Section>

          <Section title={t("byMonthTitle")}>
            <ReportScroll>
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="border-b border-op-border text-op-muted">
                    <th className={`${TH} text-left`}>{t("colMonth")}</th>
                    {SUPPLIER_CREDIT_NOTE_KINDS.map((k) => (
                      <th key={k} className={`${TH} text-right`}>
                        {t(KIND_LABEL_KEY[k])}
                      </th>
                    ))}
                    <th className={`${TH} text-right`}>{t("colTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byMonth.map((m) => (
                    <tr key={m.month} className="border-b border-op-border/60 last:border-b-0">
                      <td className={`${TD} capitalize`}>{monthLabel(m.month)}</td>
                      {SUPPLIER_CREDIT_NOTE_KINDS.map((k) => (
                        <td key={k} className={NUM}>
                          {m.byKind[k] ? money(m.byKind[k]) : "—"}
                        </td>
                      ))}
                      <td className={`${NUM} font-semibold`}>{money(m.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ReportScroll>
          </Section>

          <Section title={t("detailTitle")}>
            <ReportScroll>
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr className="border-b border-op-border text-op-muted">
                    <th className={`${TH} text-left`}>{t("colDate")}</th>
                    <th className={`${TH} text-left`}>{t("colNumber")}</th>
                    <th className={`${TH} text-left`}>{t("colSupplier")}</th>
                    <th className={`${TH} text-left`}>{t("colKind")}</th>
                    <th className={`${TH} text-right`}>{t("colIva")}</th>
                    <th className={`${TH} text-right`}>{t("colTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.id} className="border-b border-op-border/60 last:border-b-0">
                      <td className={`${TD} whitespace-nowrap`}>{fmtIsoDate(r.date, loc)}</td>
                      <td className={TD}>
                        <Link href={creditNoteListHref({ nota: r.id })} className="font-mono hover:underline">
                          {r.number}
                        </Link>
                      </td>
                      <td className={TD}>{r.supplierName}</td>
                      <td className={TD}>
                        {t(KIND_LABEL_KEY[r.kind])}
                        {r.agreement && <div className="text-xs text-op-muted">{r.agreement}</div>}
                      </td>
                      <td className={NUM}>{r.ivaCents ? money(r.ivaCents) : "—"}</td>
                      <td className={`${NUM} font-semibold`}>{money(r.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ReportScroll>
          </Section>
        </>
      )}
    </ReportShell>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-2">
      <h2 className="text-[11px] uppercase tracking-wider text-op-muted">{title}</h2>
      <div className="min-w-0 overflow-hidden rounded-2xl border border-op-border bg-op-surface">{children}</div>
    </section>
  );
}
