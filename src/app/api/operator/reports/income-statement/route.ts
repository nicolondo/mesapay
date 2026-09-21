import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { buildReportCsv, csvResponse } from "@/lib/erp/reports/csv";
import { buildIncomeStatement, incomeStatementCsvRows } from "@/lib/erp/reports/incomeStatement";
import { incomeStatementQuery, periodFromQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { periodToUtcRange } from "@/lib/erp/reports/period";
import { loadReportAccounts, loadResultMovements } from "@/lib/erp/reports/queries";
import { labelText, type StatementLabel } from "@/lib/erp/reports/statementLabel";
import type { ModuleSlug } from "@/lib/modules";
import { fmtIsoDate } from "@/app/operator/reportes/_components/fmt";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Estado de resultado: `?anio=&desde=&hasta=[&format=csv]` (prioridad de
 * `resolveReportPeriod`: fechas explícitas → ejercicio → 1 de enero → hoy).
 * JSON `{ period, country, classification, cascade, summary, months,
 * issues, hasMovements }` con las etiquetas ya traducidas, o CSV
 * `estado-resultado-<desde>-a-<hasta>.csv` (Sección, Código, Concepto,
 * Valor) con bandas, líneas, subtotales y total.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = incomeStatementQuery.safeParse(
    searchParamsToObject(new URL(req.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const q = parsed.data;
  const period = periodFromQuery(q);
  if (!period) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const { from, to } = periodToUtcRange(period);
  const [movements, accounts, t] = await Promise.all([
    loadResultMovements(ctx.restaurantId, from, to),
    loadReportAccounts(ctx.restaurantId),
    getTranslations("opReportes"),
  ]);
  const stmt = buildIncomeStatement({
    movements,
    accounts,
    country: ctx.country,
    from: period.desde,
    to: period.hasta,
  });
  const label = (l: StatementLabel) => labelText(l, t);

  if (q.format === "csv") {
    const [currency, locale] = await Promise.all([
      getCurrencyForCountry(ctx.country),
      getLocale(),
    ]);
    const loc = locale as Locale;
    const periodLabel = t("periodLabel", {
      from: fmtIsoDate(period.desde, loc),
      to: fmtIsoDate(period.hasta, loc),
    });
    const csv = buildReportCsv({
      headers: [
        t("csvSection"),
        t("csvCode"),
        t("csvConcept"),
        t("colValueCurrency", { currency }),
      ],
      rows: incomeStatementCsvRows(stmt, label),
      note:
        period.year != null
          ? `${t("isYearLabel", { year: period.year })} · ${periodLabel} · ${currency}`
          : `${periodLabel} · ${currency}`,
    });
    return csvResponse(`estado-resultado-${period.desde}-a-${period.hasta}.csv`, csv);
  }

  return NextResponse.json({
    period: { desde: period.desde, hasta: period.hasta, year: period.year },
    country: stmt.country,
    classification: stmt.classification,
    cascade: stmt.cascade.map((r) => ({ ...r, label: label(r.label) })),
    summary: stmt.summary,
    months: stmt.months,
    issues: stmt.issues.map(label),
    hasMovements: stmt.hasMovements,
  });
}

export const GET = secureApi(GETHandler);
