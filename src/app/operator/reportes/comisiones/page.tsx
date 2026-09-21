import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney, localeTag } from "@/lib/format";
import { commissionPeriodFromQuery, commissionsQuery } from "@/lib/erp/reports/params";
import { currentMonthPeriod, todayIso } from "@/lib/erp/reports/period";
import { loadSealedCommissions } from "@/lib/erp/reports/waiterCommissionQueries";
import {
  accountLabel,
  buildCommissionReport,
  type CommissionPersonRow,
  type CommissionRow,
} from "@/lib/waiterCommissions";
import { firstParam, reportGate } from "../_components/gate";
import { fmtIsoDate } from "../_components/fmt";
import { PrintButton } from "../_components/PrintButton";
import { ReportPeriod } from "../_components/ReportPeriod";
import { EmptyNote, ReportFilterForm, ReportShell, StatTile } from "../_components/ReportShell";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TH = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
const TD = "px-3 py-2";
const NUM = "px-3 py-2 text-right font-mono tabular whitespace-nowrap";

function csvLink(format: "csv-resumen" | "csv-detalle", period: { desde: string; hasta: string }) {
  const sp = new URLSearchParams({ desde: period.desde, hasta: period.hasta, format });
  return `/api/operator/reports/commissions?${sp.toString()}`;
}

/**
 * Comisiones de ventas por mesero. Portado de zenith
 * `reportes/comisiones/page.tsx`: período por FECHA DE PAGO (default mes
 * en curso), resumen por persona, detalle cuenta a cuenta, estadísticas y
 * dos CSV. Lo que se muestra es lo SELLADO en cada cuenta al cobrarla
 * (mesero, %, base y comisión), no el % de hoy.
 */
export default async function ComisionesPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tSettings, locale] = await Promise.all([
    getTranslations("opComisiones"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const sp = await searchParams;
  const raw = { desde: firstParam(sp.desde), hasta: firstParam(sp.hasta) };
  const parsed = commissionsQuery.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([, v]) => v)),
  );
  const today = todayIso();
  const period =
    commissionPeriodFromQuery(parsed.success ? parsed.data : {}, today) ??
    currentMonthPeriod(today);

  const rows = await loadSealedCommissions(gate.restaurantId, period);
  const report = buildCommissionReport(rows);

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const pctFmt = new Intl.NumberFormat(localeTag(loc), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const pct = (bps: number | null) => (bps === null ? t("pctVarious") : `${pctFmt.format(bps / 100)} %`);
  const labels = {
    table: (n: number) => t("accountTable", { n }),
    pickup: t("accountPickup"),
    manual: t("accountManual"),
  };
  const desdeLabel = fmtIsoDate(period.desde, loc);
  const hastaLabel = fmtIsoDate(period.hasta, loc);
  const periodVars = { desde: desdeLabel, hasta: hastaLabel };

  return (
    <ReportShell
      title={t("title")}
      description={t("subtitle", periodVars)}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("printTitle"),
        subtitle: t("periodLabel", periodVars),
      }}
      filters={
        <ReportFilterForm>
          <ReportPeriod
            key={`${period.desde}-${period.hasta}`}
            desde={period.desde}
            hasta={period.hasta}
            step="mes"
          />
        </ReportFilterForm>
      }
      actions={
        <>
          <a
            href={csvLink("csv-resumen", period)}
            className="mp-btn mp-btn--ghost mp-btn--sm no-print"
            download
          >
            {t("csvSummary")}
          </a>
          <a
            href={csvLink("csv-detalle", period)}
            className="mp-btn mp-btn--ghost mp-btn--sm no-print"
            download
          >
            {t("csvDetail")}
          </a>
          <PrintButton />
        </>
      }
      statCols={3}
      stats={
        <>
          <StatTile
            label={t("statCollected")}
            value={
              <>
                {money(report.totals.baseCents)}
                <span className="mt-0.5 block text-xs font-normal text-op-muted">
                  {t("ordersCount", { n: report.totals.orders })}
                </span>
              </>
            }
          />
          <StatTile label={t("statCommission")} value={money(report.totals.commissionCents)} />
          <StatTile label={t("statPeople")} value={String(report.totals.people)} />
        </>
      }
      note={t("note")}
    >
      {report.totals.orders === 0 ? (
        <EmptyNote>{t("empty")}</EmptyNote>
      ) : (
        <>
          <section className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
            <h2 className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-wider text-op-muted">
              {t("sectionSummary")}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-op-muted">
                  <tr>
                    <th className={`${TH} text-left`}>{t("colPerson")}</th>
                    <th className={`${TH} text-right`}>{t("colOrders")}</th>
                    <th className={`${TH} text-right`}>{t("colCollected")}</th>
                    <th className={`${TH} text-right`}>{t("colPct")}</th>
                    <th className={`${TH} text-right`}>{t("colCommission")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.summary.map((p: CommissionPersonRow) => (
                    <tr key={p.waiterId} className="border-t border-op-border/40">
                      <td className={TD}>{p.waiterName}</td>
                      <td className={NUM}>{p.orders}</td>
                      <td className={NUM}>{money(p.baseCents)}</td>
                      <td className={NUM}>{pct(p.bps)}</td>
                      <td className={`${NUM} font-semibold`}>{money(p.commissionCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-op-border font-semibold">
                    <td className={TD}>{t("csvTotal")}</td>
                    <td className={NUM}>{report.totals.orders}</td>
                    <td className={NUM}>{money(report.totals.baseCents)}</td>
                    <td className={NUM} />
                    <td className={NUM}>{money(report.totals.commissionCents)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
            <h2 className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-wider text-op-muted">
              {t("sectionDetail")}
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-op-muted">
                  <tr>
                    <th className={`${TH} text-left`}>{t("colPaidAt")}</th>
                    <th className={`${TH} text-left`}>{t("colAccount")}</th>
                    <th className={`${TH} text-left`}>{t("colTable")}</th>
                    <th className={`${TH} text-left`}>{t("colPerson")}</th>
                    <th className={`${TH} text-right`}>{t("colCollected")}</th>
                    <th className={`${TH} text-right`}>{t("colPct")}</th>
                    <th className={`${TH} text-right`}>{t("colCommission")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.detail.map((r: CommissionRow) => (
                    <tr key={r.orderId} className="border-t border-op-border/40">
                      <td className={`${TD} whitespace-nowrap`}>{fmtIsoDate(r.paidAt, loc)}</td>
                      <td className={`${TD} font-mono`}>{r.shortCode}</td>
                      <td className={TD}>{accountLabel(r, labels)}</td>
                      <td className={TD}>{r.waiterName}</td>
                      <td className={NUM}>{money(r.baseCents)}</td>
                      <td className={NUM}>{pct(r.bps)}</td>
                      <td className={NUM}>{money(r.commissionCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </ReportShell>
  );
}
