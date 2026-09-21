import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { buildReportCsv, csvResponse } from "@/lib/erp/reports/csv";
import { makeSourceLabel } from "@/lib/erp/reports/labels";
import { baseReportQuery, periodFromQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { currentMonthPeriod, todayIso } from "@/lib/erp/reports/period";
import { taxesDetailCsvRows } from "@/lib/erp/reports/taxesDetail";
import { loadTaxesDetailReport } from "@/lib/erp/reports/taxesReport";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Impuestos detallados: `?desde&hasta[&format=csv]` (sin fechas: el mes
 * en curso). JSON `{ period, sales, purchases, practicadas, aFavor, stats }`
 * (una fila por documento y tarifa; retenciones por comprobante) o CSV
 * `impuestos-detallados-<desde>-a-<hasta>.csv` con las columnas Sección,
 * Fecha, Documento, NIT, Tercero, Impuesto/Concepto, Tarifa, Base, Valor.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = baseReportQuery.safeParse(searchParamsToObject(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const q = parsed.data;
  const today = todayIso();
  const period = periodFromQuery(q.desde || q.hasta || q.anio ? q : currentMonthPeriod(today), today);
  if (!period) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const detail = await loadTaxesDetailReport(ctx.restaurantId, period);

  if (q.format === "csv") {
    const [t, tRep, tErp] = await Promise.all([
      getTranslations("opImpuestosRep"),
      getTranslations("opReportes"),
      getTranslations("opErp"),
    ]);
    const csv = buildReportCsv({
      headers: [
        t("colSection"),
        tRep("colDate"),
        t("colDocument"),
        t("colNit"),
        t("colParty"),
        t("colTaxOrConcept"),
        t("colRate"),
        t("colBase"),
        t("colValue"),
      ],
      rows: taxesDetailCsvRows(detail, {
        sections: {
          sales: t("secSales"),
          purchases: t("secPurchases"),
          practicadas: t("secRetPracticed"),
          aFavor: t("secRetFavor"),
        },
        taxLabel: (kind) => (kind === "iva" ? t("famIva") : t("famInc")),
        finalConsumer: t("finalConsumer"),
        unnumbered: tRep("unnumbered"),
        voided: tRep("voided"),
        sourceLabel: makeSourceLabel(tErp),
      }),
    });
    return csvResponse(`impuestos-detallados-${period.desde}-a-${period.hasta}.csv`, csv);
  }

  return NextResponse.json({
    period: { desde: period.desde, hasta: period.hasta },
    sales: detail.sales,
    purchases: detail.purchases,
    practicadas: detail.practicadas,
    aFavor: detail.aFavor,
    stats: detail.stats,
  });
}

export const GET = secureApi(GETHandler);
