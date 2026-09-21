import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import {
  buildPartnerSummary,
  NO_SUPPLIER_ID,
  type CarteraKind,
  type CarteraSide,
} from "@/lib/erp/reports/cartera";
import { loadPayablesDocs, loadReceivableDocs } from "@/lib/erp/reports/carteraQueries";
import { carteraQuery } from "@/lib/erp/reports/params";
import { todayIso } from "@/lib/erp/reports/period";
import { firstParam, reportGate } from "../_components/gate";
import { fmtIsoDate } from "../_components/fmt";
import { PrintButton } from "../_components/PrintButton";
import {
  CsvButton,
  csvHref,
  EmptyNote,
  FilterField,
  ReportFilterForm,
  ReportShell,
  ReportTabs,
  StatTile,
} from "../_components/ReportShell";
import { BucketBadge } from "./BucketBadge";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Vista = "todas" | "cxc" | "cxp";

const TH = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
const NUM = "px-3 py-2 text-right font-mono tabular whitespace-nowrap";

/** Segmento de la URL del extracto por lado. */
const KIND_SLUG: Record<CarteraKind, "proveedor" | "cliente"> = { cxp: "proveedor", cxc: "cliente" };

function carteraHref(vista: Vista, hasta: string): string {
  const sp = new URLSearchParams();
  if (vista !== "todas") sp.set("vista", vista);
  sp.set("hasta", hasta);
  return `/operator/reportes/cartera?${sp.toString()}`;
}

/**
 * Cartera: cuentas por cobrar (cortes de bonos a crédito) y por pagar
 * (OC recibidas y gastos) por tercero, con antigüedad por vencimiento y
 * corte «a una fecha». Portado de zenith `reportes/cartera/page.tsx`.
 */
export default async function CarteraPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tSettings, locale] = await Promise.all([
    getTranslations("opCartera"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const sp = await searchParams;
  const raw = { vista: firstParam(sp.vista), hasta: firstParam(sp.hasta) };
  const parsed = carteraQuery.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([, v]) => v)),
  );
  const q = parsed.success ? parsed.data : {};
  const asOf = q.hasta ?? todayIso();
  const vista: Vista = q.vista ?? "todas";

  const [payableDocs, receivable] = await Promise.all([
    loadPayablesDocs(gate.restaurantId, asOf),
    loadReceivableDocs(gate.restaurantId, asOf),
  ]);
  const payables = buildPartnerSummary(payableDocs, asOf);
  const receivables = buildPartnerSummary(receivable.docs, asOf);

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const dateLabel = fmtIsoDate(asOf, loc);

  const tabs: { key: Vista; label: string }[] = [
    { key: "todas", label: t("tabAll") },
    { key: "cxc", label: t("tabCxc") },
    { key: "cxp", label: t("tabCxp") },
  ];

  const statNote = (partners: string, docs: string) => (
    <span className="mt-0.5 block text-xs font-normal text-op-muted">
      {partners} · {docs}
    </span>
  );

  return (
    <ReportShell
      title={t("title")}
      description={t("subtitle", { date: dateLabel })}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("printTitle"),
        subtitle: t("asOf", { date: dateLabel }),
      }}
      filters={
        <div className="space-y-3">
          <ReportTabs
            label={t("tabsLabel")}
            options={tabs}
            active={vista}
            href={(k) => carteraHref(k, asOf)}
          />
          <ReportFilterForm keep={{ vista: vista === "todas" ? undefined : vista }}>
            <FilterField label={t("filterAsOf")}>
              <input
                type="date"
                name="hasta"
                defaultValue={asOf}
                className="w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </FilterField>
          </ReportFilterForm>
        </div>
      }
      actions={
        <>
          <CsvButton
            href={csvHref("/api/operator/reports/cartera", {
              vista: vista === "todas" ? undefined : vista,
              hasta: asOf,
            })}
          />
          <PrintButton />
        </>
      }
      statCols={2}
      stats={
        <>
          <StatTile
            label={t("statReceivable")}
            value={
              <>
                {money(receivables.totals.outstandingCents)}
                {statNote(
                  t("customers", { n: receivables.totals.partners }),
                  t("documents", { n: receivables.totals.docs }),
                )}
              </>
            }
          />
          <StatTile
            label={t("statPayable")}
            value={
              <>
                {money(payables.totals.outstandingCents)}
                {statNote(
                  t("suppliers", { n: payables.totals.partners }),
                  t("documents", { n: payables.totals.docs }),
                )}
              </>
            }
          />
        </>
      }
      note={t("note")}
    >
      <div className="text-sm text-op-muted">{t("asOf", { date: dateLabel })}</div>

      {vista !== "cxp" && (
        <Section
          title={t("sectionCxc")}
          kind="cxc"
          side={receivables}
          asOf={asOf}
          money={money}
          locale={loc}
          totalLabel={t("statReceivable")}
          empty={
            receivable.enabled ? (
              <EmptyNote>{t("emptyCxc")}</EmptyNote>
            ) : (
              <EmptyNote>
                <span className="block font-medium text-op-text">{t("cxcDisabledTitle")}</span>
                <span className="mt-1 block">{t("cxcDisabledBody")}</span>
              </EmptyNote>
            )
          }
        />
      )}

      {vista !== "cxc" && (
        <Section
          title={t("sectionCxp")}
          kind="cxp"
          side={payables}
          asOf={asOf}
          money={money}
          locale={loc}
          totalLabel={t("statPayable")}
          empty={<EmptyNote>{t("emptyCxp")}</EmptyNote>}
        />
      )}
    </ReportShell>
  );
}

/** Una sección (por cobrar / por pagar): título + tabla por tercero + total. */
async function Section({
  title,
  kind,
  side,
  asOf,
  money,
  locale,
  totalLabel,
  empty,
}: {
  title: string;
  kind: CarteraKind;
  side: CarteraSide;
  asOf: string;
  money: (c: number) => string;
  locale: Locale;
  totalLabel: string;
  empty: ReactNode;
}) {
  const t = await getTranslations("opCartera");
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] uppercase tracking-wider text-op-muted">{title}</h2>
      {side.partners.length === 0 ? (
        empty
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-op-border text-op-muted">
                  <th className={`${TH} text-left`}>{t("colPartner")}</th>
                  <th className={`${TH} text-left`}>{t("colTaxId")}</th>
                  <th className={`${TH} text-right`}>{t("colDocs")}</th>
                  <th className={`${TH} text-left`}>{t("colOldestDue")}</th>
                  <th className={`${TH} text-left`}>{t("colAging")}</th>
                  <th className={`${TH} text-right`}>{t("colBalance")}</th>
                </tr>
              </thead>
              <tbody>
                {side.partners.map((p) => (
                  <tr key={p.partnerId} className="border-b border-op-border/60 last:border-b-0">
                    <td className="px-3 py-2 min-w-0">
                      <Link
                        href={`/operator/reportes/cartera/${KIND_SLUG[kind]}/${encodeURIComponent(p.partnerId)}?hasta=${asOf}`}
                        className="font-medium hover:underline"
                      >
                        {p.partnerId === NO_SUPPLIER_ID ? t("noSupplier") : p.partnerName}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-op-muted whitespace-nowrap">
                      {p.partnerTaxId ?? "—"}
                    </td>
                    <td className={NUM}>{p.docs}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtIsoDate(p.oldestDue, locale)}</td>
                    <td className="px-3 py-2">
                      <BucketBadge bucket={p.worstBucket} />
                    </td>
                    <td className={`${NUM} font-semibold`}>{money(p.outstandingCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                  <td className="px-3 py-2" colSpan={2}>
                    {totalLabel}
                  </td>
                  <td className={NUM}>{side.totals.docs}</td>
                  <td colSpan={2} />
                  <td className={NUM}>{money(side.totals.outstandingCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
