import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { buildReportCsv, csvResponse } from "@/lib/erp/reports/csv";
import {
  commissionPeriodFromQuery,
  commissionsQuery,
  searchParamsToObject,
} from "@/lib/erp/reports/params";
import { isoDateUtc } from "@/lib/erp/reports/period";
import { loadSealedCommissions } from "@/lib/erp/reports/waiterCommissionQueries";
import type { ModuleSlug } from "@/lib/modules";
import {
  accountLabel,
  buildCommissionReport,
  commissionCsvDetail,
  commissionCsvSummary,
} from "@/lib/waiterCommissions";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Comisiones de meseros del período (por FECHA DE PAGO, default mes en
 * curso): `?desde&hasta[&format=csv-resumen|csv-detalle]`. JSON
 * `{ period, summary, detail, totals }` con lo SELLADO en cada cuenta al
 * cobrarla. Dos CSV: el resumen por persona con fila TOTAL
 * (`comisiones-<desde>-a-<hasta>.csv`) y la cuenta a cuenta
 * (`comisiones-detalle-<desde>-a-<hasta>.csv`).
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = commissionsQuery.safeParse(searchParamsToObject(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const q = parsed.data;
  const period = commissionPeriodFromQuery(q);
  if (!period) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const rows = await loadSealedCommissions(ctx.restaurantId, period);
  const report = buildCommissionReport(rows);

  if (q.format === "csv-resumen" || q.format === "csv-detalle") {
    const t = await getTranslations("opComisiones");
    const note = t("csvNote", { desde: period.desde, hasta: period.hasta });
    const suffix = `${period.desde}-a-${period.hasta}.csv`;
    if (q.format === "csv-resumen") {
      const csv = buildReportCsv({
        headers: [t("colPerson"), t("colOrders"), t("colCollected"), t("colPct"), t("colCommission")],
        rows: commissionCsvSummary(report, { total: t("csvTotal"), various: t("pctVarious") }),
        note,
      });
      return csvResponse(`comisiones-${suffix}`, csv);
    }
    const labels = {
      table: (n: number) => t("accountTable", { n }),
      pickup: t("accountPickup"),
      manual: t("accountManual"),
    };
    const csv = buildReportCsv({
      headers: [
        t("colPaidAt"),
        t("colAccount"),
        t("colTable"),
        t("colPerson"),
        t("colCollected"),
        t("colPct"),
        t("colCommission"),
      ],
      rows: commissionCsvDetail(report.detail, {
        date: (iso) => isoDateUtc(new Date(iso)),
        account: (r) => accountLabel(r, labels),
      }),
      note,
    });
    return csvResponse(`comisiones-detalle-${suffix}`, csv);
  }

  return NextResponse.json({ period, ...report });
}

export const GET = secureApi(GETHandler);
