import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { baseReportQuery, periodFromQuery } from "@/lib/erp/reports/params";
import { currentMonthPeriod, todayIso } from "@/lib/erp/reports/period";
import { loadTaxesReport } from "@/lib/erp/reports/taxesReport";
import { firstParam, reportGate } from "../_components/gate";
import { fmtIsoDate } from "../_components/fmt";
import { PrintButton } from "../_components/PrintButton";
import { ReportPeriod } from "../_components/ReportPeriod";
import { ReportFilterForm, ReportShell, StatTile } from "../_components/ReportShell";
import {
  TaxCrossTable,
  TaxDocumentTable,
  TaxFamilyCards,
  TaxGroupCards,
} from "./TaxSections";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Impuestos del período (portado de zenith `/reportes/impuestos`, sin el
 * trámite de declaración ni el formulario 300):
 *  A. impuestos DOCUMENTALES por tarifa (IVA/INC generado en ventas, IVA
 *     registrado en compras, retenciones practicadas en compras);
 *  B. retenciones y pasivos tributarios desde el LIBRO por familia;
 *  C. cruce documental vs libro.
 * Paso natural: el mes (default, el mes en curso). Se calcula en el
 * servidor con la misma librería que la API. Sin CSV (como en zenith); el
 * detalle documento por documento y su CSV están en «Impuestos detallados».
 */
export default async function ImpuestosPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tRep, tSettings, locale] = await Promise.all([
    getTranslations("opImpuestosRep"),
    getTranslations("opReportes"),
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
  // En la página se es tolerante: lo inválido se ignora en vez de romper.
  const parsed = baseReportQuery
    .omit({ format: true })
    .safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v)));
  const q = parsed.success ? parsed.data : {};
  const today = todayIso();
  const fallback = currentMonthPeriod(today);
  const period =
    periodFromQuery(q.desde || q.hasta || q.anio ? q : fallback, today) ??
    periodFromQuery(fallback, today)!;

  const report = await loadTaxesReport(gate.restaurantId, period);

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const periodLabel = tRep("periodLabel", {
    from: fmtIsoDate(period.desde, loc),
    to: fmtIsoDate(period.hasta, loc),
  });
  const detailHref = `/operator/reportes/impuestos-detallados?desde=${period.desde}&hasta=${period.hasta}`;

  return (
    <ReportShell
      title={t("title")}
      description={t("subtitle")}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("title"),
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
          <Link href={detailHref} className="mp-btn mp-btn--ghost mp-btn--sm no-print">
            {t("detailLink")}
          </Link>
          <PrintButton />
        </>
      }
      statCols={3}
      stats={
        <>
          <StatTile label={t("statGenerated")} value={money(report.stats.generados)} />
          <StatTile label={t("statIva")} value={money(report.stats.ivaGenerado)} />
          <StatTile label={t("statInc")} value={money(report.stats.incGenerado)} />
        </>
      }
      note={t("pageNote")}
    >
      <div className="text-sm text-op-muted">
        {periodLabel} · {t("statGeneratedHint")}
      </div>

      {/* A. Impuestos documentales */}
      <TaxFamilyCards docs={report.documental} currency={gate.currency} />
      <TaxDocumentTable
        title={t("salesTableTitle")}
        note={t("salesTableNote")}
        rows={report.documental.sales}
        currency={gate.currency}
      />
      <TaxDocumentTable
        title={t("purchasesTableTitle")}
        note={t("purchasesTableNote")}
        rows={report.documental.purchases}
        currency={gate.currency}
      />
      {report.documental.retentions.length > 0 && (
        <TaxDocumentTable
          title={t("retTableTitle")}
          note={t("retTableNote")}
          rows={report.documental.retentions}
          currency={gate.currency}
        />
      )}

      {/* C. Cruce con la contabilidad */}
      <TaxCrossTable cross={report.cross} currency={gate.currency} />

      {/* B. Retenciones y demás impuestos desde el libro */}
      <TaxGroupCards book={report.book} currency={gate.currency} />
    </ReportShell>
  );
}
