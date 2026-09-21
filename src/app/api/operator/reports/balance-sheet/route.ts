import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  balanceSheetCsvRows,
  buildBalanceSheet,
  openPeriodStart,
} from "@/lib/erp/reports/balanceSheet";
import { buildReportCsv, csvResponse } from "@/lib/erp/reports/csv";
import { balanceSheetQuery, cutoffFromQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { periodToUtcRange } from "@/lib/erp/reports/period";
import {
  loadBalancesThrough,
  loadClosingDates,
  loadReportAccounts,
} from "@/lib/erp/reports/queries";
import type { ModuleSlug } from "@/lib/modules";
import { fmtIsoDate, fmtIsoDateNumeric } from "@/app/operator/reportes/_components/fmt";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Estado de situación financiera: `?corte=yyyy-mm-dd[&format=csv]`
 * (corte inclusivo; por defecto hoy). JSON `{ cutoff, openYearStart,
 * sections: { activo, pasivo, patrimonio }, totals, balanced }` o CSV
 * `estado-situacion-financiera-<corte>.csv` (Sección, Código, Cuenta,
 * Valor) con el árbol completo, subtotales y totales, y la nota del corte
 * como primera fila.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = balanceSheetQuery.safeParse(
    searchParamsToObject(new URL(req.url).searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const q = parsed.data;
  const cutoff = cutoffFromQuery(q);
  const { to } = periodToUtcRange({ desde: cutoff, hasta: cutoff });
  const [balances, accounts, closings, t, locale] = await Promise.all([
    loadBalancesThrough(ctx.restaurantId, to),
    loadReportAccounts(ctx.restaurantId),
    loadClosingDates(ctx.restaurantId),
    getTranslations("opReportes"),
    getLocale(),
  ]);
  const loc = locale as Locale;
  const openYearStart = openPeriodStart(closings, cutoff);
  const bs = buildBalanceSheet({
    balances,
    accounts,
    cutoff,
    openYearStart,
    utilidadLabel: t("bsUtilidad", { since: fmtIsoDateNumeric(openYearStart, loc) }),
  });

  if (q.format === "csv") {
    const csv = buildReportCsv({
      headers: [t("csvSection"), t("csvCode"), t("colAccount"), t("colValue")],
      rows: balanceSheetCsvRows(bs, {
        activo: t("bsActivo"),
        pasivo: t("bsPasivo"),
        patrimonio: t("bsPatrimonio"),
        totalActivo: t("bsTotalActivo"),
        totalPasivo: t("bsTotalPasivo"),
        totalPatrimonio: t("bsTotalPatrimonio"),
        totalPasivoPatrimonio: t("bsTotalPasivoPatrimonio"),
      }),
      note: t("bsCsvNote", { date: fmtIsoDate(cutoff, loc) }),
    });
    return csvResponse(`estado-situacion-financiera-${cutoff}.csv`, csv);
  }

  return NextResponse.json({
    cutoff: bs.cutoff,
    openYearStart: bs.openYearStart,
    sections: bs.sections,
    totals: bs.totals,
    balanced: bs.balanced,
  });
}

export const GET = secureApi(GETHandler);
