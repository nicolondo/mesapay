import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { buildReportCsv, csvResponse } from "@/lib/erp/reports/csv";
import { periodFromQuery, searchParamsToObject, trialBalanceQuery } from "@/lib/erp/reports/params";
import { periodToUtcRange } from "@/lib/erp/reports/period";
import { loadReportAccounts, loadTrialBalanceRows } from "@/lib/erp/reports/queries";
import {
  buildTrialBalance,
  parseTrialBalanceLevel,
  trialBalanceCsvRows,
} from "@/lib/erp/reports/trialBalance";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Balance de prueba: `?desde&hasta&nivel=1|2|4|6&cta1&cta2[&format=csv]`.
 * JSON `{ period, level, rows, totals, balanced, differenceCents, filtered }`
 * o CSV `balance-prueba-<desde>-a-<hasta>.csv` con la jerarquía completa
 * y la fila TOTAL.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = trialBalanceQuery.safeParse(
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
  const [rows, accounts] = await Promise.all([
    loadTrialBalanceRows(ctx.restaurantId, from, to),
    loadReportAccounts(ctx.restaurantId),
  ]);
  const tb = buildTrialBalance(rows, {
    level: parseTrialBalanceLevel(q.nivel),
    accountFrom: q.cta1,
    accountTo: q.cta2,
    accounts,
  });

  if (q.format === "csv") {
    const t = await getTranslations("opReportes");
    const csv = buildReportCsv({
      headers: [
        t("csvCode"),
        t("colAccount"),
        t("colInitial"),
        t("colDebits"),
        t("colCredits"),
        t("colFinal"),
      ],
      rows: trialBalanceCsvRows(tb, t("csvTotal")),
      note: tb.filtered ? t("filteredTotals") : null,
    });
    return csvResponse(`balance-prueba-${period.desde}-a-${period.hasta}.csv`, csv);
  }

  return NextResponse.json({
    period: { desde: period.desde, hasta: period.hasta },
    level: tb.level,
    rows: tb.rows,
    totals: tb.totals,
    balanced: tb.balanced,
    differenceCents: tb.differenceCents,
    filtered: tb.filtered,
  });
}

export const GET = secureApi(GETHandler);
