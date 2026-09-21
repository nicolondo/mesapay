import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { buildReportCsv, csvResponse } from "@/lib/erp/reports/csv";
import { buildDailyBook, dailyBookCsvRows, parseDailyBookMode } from "@/lib/erp/reports/dailyBook";
import { makeSourceLabel } from "@/lib/erp/reports/labels";
import { dailyBookQuery, periodFromQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { currentMonthPeriod, periodToUtcRange, todayIso } from "@/lib/erp/reports/period";
import { loadEntriesWithLines } from "@/lib/erp/reports/queries";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Libro diario: `?desde&hasta&modo=detallado|resumido[&format=csv]`. Sin
 * fechas, el MES en curso (el paso natural del diario). JSON
 * `{ period, mode, entries | days, stats }` o CSV (detallado: Fecha,
 * Comprobante, Origen, Descripción, Cuenta, Nombre cuenta, Débito,
 * Crédito; resumido: Fecha, Cuenta, Nombre, Débitos, Créditos).
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = dailyBookQuery.safeParse(
    searchParamsToObject(new URL(req.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const q = parsed.data;
  const today = todayIso();
  const period = periodFromQuery(
    q.desde || q.hasta || q.anio ? q : currentMonthPeriod(today),
    today,
  );
  if (!period) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const mode = parseDailyBookMode(q.modo);
  const { from, to } = periodToUtcRange(period);
  const entries = await loadEntriesWithLines(ctx.restaurantId, from, to);
  const book = buildDailyBook(entries, { mode });

  if (q.format === "csv") {
    const [t, tErp] = await Promise.all([
      getTranslations("opReportes"),
      getTranslations("opErp"),
    ]);
    const headers =
      mode === "resumido"
        ? [t("colDate"), t("colAccount"), t("colName"), t("colDebits"), t("colCredits")]
        : [
            t("colDate"),
            t("colVoucher"),
            t("colSource"),
            t("colDescription"),
            t("colAccount"),
            t("colAccountName"),
            t("colDebit"),
            t("colCredit"),
          ];
    const csv = buildReportCsv({
      headers,
      rows: dailyBookCsvRows(book, {
        unnumbered: t("unnumbered"),
        voided: t("voided"),
        sourceLabel: makeSourceLabel(tErp),
      }),
    });
    return csvResponse(`libro-diario-${mode}-${period.desde}-a-${period.hasta}.csv`, csv);
  }

  return NextResponse.json({
    period: { desde: period.desde, hasta: period.hasta },
    ...book,
  });
}

export const GET = secureApi(GETHandler);
