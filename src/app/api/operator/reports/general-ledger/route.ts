import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { buildReportCsv, csvResponse } from "@/lib/erp/reports/csv";
import { buildGeneralLedger, generalLedgerCsvRows } from "@/lib/erp/reports/generalLedger";
import { makeSourceLabel } from "@/lib/erp/reports/labels";
import { generalLedgerQuery, periodFromQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { periodToUtcRange } from "@/lib/erp/reports/period";
import { loadLedgerLines, loadReportAccounts } from "@/lib/erp/reports/queries";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Libro mayor: `?desde&hasta&cuenta[&format=csv]`. JSON
 * `{ period, accounts: [{ code, name, nature, initialCents, debitCents,
 * creditCents, balanceCents, movements: [...] }], totals, balanced }` o
 * CSV (Cuenta, Nombre, Fecha, Comprobante, Origen, Descripción, Debe,
 * Haber, Saldo) con una fila de saldo inicial por cuenta.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = generalLedgerQuery.safeParse(
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
  const [lines, accounts] = await Promise.all([
    loadLedgerLines(ctx.restaurantId, to, q.cuenta),
    loadReportAccounts(ctx.restaurantId),
  ]);
  const ledger = buildGeneralLedger(lines, accounts, { from, to, accountCode: q.cuenta });

  if (q.format === "csv") {
    const [t, tErp] = await Promise.all([
      getTranslations("opReportes"),
      getTranslations("opErp"),
    ]);
    const csv = buildReportCsv({
      headers: [
        t("colAccount"),
        t("colName"),
        t("colDate"),
        t("colVoucher"),
        t("colSource"),
        t("colDescription"),
        t("colDebit"),
        t("colCredit"),
        t("colRunning"),
      ],
      rows: generalLedgerCsvRows(ledger, {
        initial: t("glInitial"),
        unnumbered: t("unnumbered"),
        sourceLabel: makeSourceLabel(tErp),
      }),
    });
    const suffix = q.cuenta ? `-${q.cuenta}` : "";
    return csvResponse(`libro-mayor${suffix}-${period.desde}-a-${period.hasta}.csv`, csv);
  }

  return NextResponse.json({
    period: { desde: period.desde, hasta: period.hasta },
    accounts: ledger.accounts,
    totals: ledger.totals,
    balanced: ledger.balanced,
  });
}

export const GET = secureApi(GETHandler);
