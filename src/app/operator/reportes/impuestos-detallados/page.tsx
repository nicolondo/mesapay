import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { makeSourceLabel } from "@/lib/erp/reports/labels";
import { baseReportQuery, periodFromQuery } from "@/lib/erp/reports/params";
import { currentMonthPeriod, todayIso } from "@/lib/erp/reports/period";
import { loadTaxesDetailReport } from "@/lib/erp/reports/taxesReport";
import { firstParam, reportGate } from "../_components/gate";
import { fmtIsoDate } from "../_components/fmt";
import { PrintButton } from "../_components/PrintButton";
import { ReportPeriod } from "../_components/ReportPeriod";
import {
  CsvButton,
  csvHref,
  ReportFilterForm,
  ReportShell,
  StatTile,
} from "../_components/ReportShell";
import { RetentionDetailTable, TaxDocDetailTable } from "../impuestos/TaxSections";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Impuestos detallados (portado de zenith `/reportes/impuestos-detallados`):
 * IVA / INC generado por factura y tarifa, IVA descontable por compra y
 * tarifa, y retenciones practicadas y a favor comprobante por comprobante
 * desde el libro. CSV con las mismas filas (lo sirve la API) e impresión.
 */
export default async function ImpuestosDetalladosPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [t, tRep, tErp, tSettings, locale] = await Promise.all([
    getTranslations("opImpuestosRep"),
    getTranslations("opReportes"),
    getTranslations("opErp"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const sp = await searchParams;
  const raw = {
    desde: firstParam(sp.desde),
    hasta: firstParam(sp.hasta),
    anio: firstParam(sp.anio),
  };
  const parsed = baseReportQuery
    .omit({ format: true })
    .safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v)));
  const q = parsed.success ? parsed.data : {};
  const today = todayIso();
  const fallback = currentMonthPeriod(today);
  const period =
    periodFromQuery(q.desde || q.hasta || q.anio ? q : fallback, today) ??
    periodFromQuery(fallback, today)!;

  const detail = await loadTaxesDetailReport(gate.restaurantId, period);

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const sourceLabel = makeSourceLabel(tErp);
  const periodLabel = tRep("periodLabel", {
    from: fmtIsoDate(period.desde, loc),
    to: fmtIsoDate(period.hasta, loc),
  });
  const filterParams = { desde: period.desde, hasta: period.hasta };

  return (
    <ReportShell
      title={t("detailTitle")}
      description={t("detailSubtitle")}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("detailTitle"),
        subtitle: periodLabel,
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
          <CsvButton href={csvHref("/api/operator/reports/taxes-detail", filterParams)} />
          <PrintButton />
        </>
      }
      statCols={4}
      stats={
        <>
          <StatTile label={t("statIva")} value={money(detail.stats.ivaGeneradoCents)} />
          <StatTile label={t("statIvaDeductible")} value={money(detail.stats.ivaDescontableCents)} />
          <StatTile label={t("statRetPracticed")} value={money(detail.stats.retencionesPracticadasCents)} />
          <StatTile label={t("statRetFavor")} value={money(detail.stats.retencionesAFavorCents)} />
        </>
      }
      note={t("detailNote")}
    >
      <div className="text-sm text-op-muted">{periodLabel}</div>

      <TaxDocDetailTable
        title={t("secSales")}
        note={t("secSalesNote")}
        rows={detail.sales}
        currency={gate.currency}
      />
      <TaxDocDetailTable
        title={t("secPurchases")}
        note={t("secPurchasesNote")}
        rows={detail.purchases}
        currency={gate.currency}
      />
      <RetentionDetailTable
        title={t("secRetPracticed")}
        note={t("secRetPracticedNote")}
        rows={detail.practicadas}
        currency={gate.currency}
        sourceLabel={sourceLabel}
      />
      <RetentionDetailTable
        title={t("secRetFavor")}
        note={t("secRetFavorNote")}
        rows={detail.aFavor}
        currency={gate.currency}
        sourceLabel={sourceLabel}
      />
    </ReportShell>
  );
}
