import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney, localeTag } from "@/lib/format";
import { buildIncomeStatement } from "@/lib/erp/reports/incomeStatement";
import { incomeStatementQuery, periodFromQuery } from "@/lib/erp/reports/params";
import { periodToUtcRange, resolveReportPeriod, todayIso } from "@/lib/erp/reports/period";
import {
  loadEntryYears,
  loadReportAccounts,
  loadResultMovements,
} from "@/lib/erp/reports/queries";
import { labelText, type StatementLabel } from "@/lib/erp/reports/statementLabel";
import { drilldownHref } from "../_components/drilldown";
import { FiscalYearPicker } from "../_components/FiscalYearPicker";
import { fmtIsoDate, fmtMonth } from "../_components/fmt";
import { firstParam, reportGate } from "../_components/gate";
import { PrintButton } from "../_components/PrintButton";
import { ReportPeriod } from "../_components/ReportPeriod";
import {
  CsvButton,
  csvHref,
  ReportFilterForm,
  ReportShell,
  StatTile,
} from "../_components/ReportShell";
import { StatementTree, type TreeRow } from "../_components/StatementTree";
import { IncomeCharts } from "./IncomeCharts";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * ESTADO DE RESULTADO por período o ejercicio. Selector de ejercicio
 * (`?anio=`, años con asientos) + par desde/hasta con paso de año; por
 * defecto «1 de enero del año en curso → hoy» (`resolveReportPeriod`).
 *
 * Se calcula en el servidor con la misma librería que la API. Cascada
 * colombiana con gastos por naturaleza cuando el comercio es de Colombia
 * (ver `incomeStatement.ts`), bandas plegables en la URL (`?abrir=`),
 * gráficas SVG propias, resumen mensual, CSV e impresión. Cada renglón
 * con código enlaza a su detalle con el mismo rango.
 */
export default async function EstadoResultadoPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tSettings, locale] = await Promise.all([
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
  const parsed = incomeStatementQuery.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([, v]) => v)),
  );
  const q = parsed.success ? parsed.data : {};
  const today = todayIso();
  const period = periodFromQuery(q, today) ?? resolveReportPeriod({ today });
  const { from, to } = periodToUtcRange(period);

  const [movements, accounts, years] = await Promise.all([
    loadResultMovements(gate.restaurantId, from, to),
    loadReportAccounts(gate.restaurantId),
    loadEntryYears(gate.restaurantId),
  ]);
  const stmt = buildIncomeStatement({
    movements,
    accounts,
    country: gate.country,
    from: period.desde,
    to: period.hasta,
  });

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const pct = new Intl.NumberFormat(localeTag(loc), { maximumFractionDigits: 1 });
  const label = (l: StatementLabel) => labelText(l, t);
  const periodLabel = t("periodLabel", {
    from: fmtIsoDate(period.desde, loc),
    to: fmtIsoDate(period.hasta, loc),
  });
  const title = period.year != null ? `${t("isYearLabel", { year: period.year })} · ${periodLabel}` : periodLabel;
  const co = stmt.classification === "co";
  const yearOptions = [...new Set([Number(today.slice(0, 4)), ...years])].sort((a, b) => b - a);
  const postable = new Set(accounts.filter((a) => a.postable).map((a) => a.code));

  const rows: TreeRow[] = stmt.rows.map((r) => ({
    key: r.key,
    code: r.code,
    name: label(r.label),
    depth: r.depth,
    ancestors: r.ancestors,
    hasChildren: r.hasChildren,
    values: r.valueCents == null ? [] : [r.valueCents],
    variant: r.variant,
    href: drilldownHref({
      code: r.code,
      postable: postable.has(r.code),
      desde: period.desde,
      hasta: period.hasta,
    }),
  }));
  const months = stmt.months.map((m) => ({ ...m, label: fmtMonth(m.key, loc) }));
  const filterParams = { desde: period.desde, hasta: period.hasta };
  const monthCols = [
    t("isColIncome"),
    t("isColCosts"),
    t("isColExpenses"),
    ...(co ? [t("isColTax")] : []),
    t("isColResult"),
    ...(co ? [t("isColOri")] : []),
  ];
  const monthValues = (m: (typeof months)[number]) => [
    m.incomeCents,
    m.costCents,
    m.expensesCents,
    ...(co ? [m.incomeTaxCents] : []),
    m.resultCents,
    ...(co ? [m.oriCents] : []),
  ];

  return (
    <ReportShell
      title={t("isTitle")}
      description={t("isSubtitle")}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("isTitle"),
        subtitle: title,
      }}
      filters={
        <ReportFilterForm keep={{ abrir: firstParam(sp.abrir) }}>
          <FiscalYearPicker years={yearOptions} year={period.year} />
          <ReportPeriod
            key={`${period.desde}-${period.hasta}`}
            desde={period.desde}
            hasta={period.hasta}
            step="año"
          />
        </ReportFilterForm>
      }
      actions={
        <>
          <CsvButton href={csvHref("/api/operator/reports/income-statement", filterParams)} />
          <PrintButton />
        </>
      }
      stats={
        <>
          <StatTile label={t("isStatIncome")} value={money(stmt.summary.incomeCents)} />
          <StatTile
            label={t("isStatResult")}
            value={money(stmt.summary.resultCents)}
            tone={stmt.summary.resultCents < 0 ? "danger" : "default"}
          />
          {co ? (
            <StatTile
              label={t("isStatIntegral")}
              value={money(stmt.summary.integralCents)}
              tone={stmt.summary.integralCents < 0 ? "danger" : "default"}
            />
          ) : (
            <StatTile
              label={t("isStatMargin")}
              value={
                stmt.summary.incomeCents > 0
                  ? `${pct.format((stmt.summary.resultCents / stmt.summary.incomeCents) * 100)} %`
                  : "—"
              }
            />
          )}
        </>
      }
      note={t("isNote")}
    >
      <div className="text-sm text-op-muted">{title}</div>

      {stmt.issues.length > 0 && (
        <div role="status" className="rounded-xl border border-op-border bg-op-bg/40 px-4 py-3 text-sm text-op-muted">
          {stmt.issues.map((issue, i) => (
            <p key={i}>{label(issue)}</p>
          ))}
        </div>
      )}

      <IncomeCharts
        summary={stmt.summary}
        months={months}
        currency={gate.currency}
        classification={stmt.classification}
        hasMovements={stmt.hasMovements}
      />

      <StatementTree
        rows={rows}
        columns={[t("colValueCurrency", { currency: gate.currency })]}
        currency={gate.currency}
        firstColumnLabel={t("csvConcept")}
      />

      {/* Resumen mensual: las cifras exactas de las barras, también en papel. */}
      <section className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <h2 className="border-b border-op-border px-3 py-2 text-[11px] uppercase tracking-wider text-op-muted">
          {t("isMonthlyTitle")}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="border-b border-op-border text-op-muted">
                <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider font-normal">
                  {t("isColMonth")}
                </th>
                {monthCols.map((c) => (
                  <th
                    key={c}
                    className="px-3 py-2 text-right font-mono text-[9px] uppercase tracking-wider font-normal"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-op-border/50">
              {months.map((m) => (
                <tr key={m.key}>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {m.label}
                    {m.partial && <span className="ml-1 text-xs text-op-muted">· {t("isPartialTag")}</span>}
                  </td>
                  {monthValues(m).map((v, i) => (
                    <td
                      key={i}
                      className={`px-3 py-1.5 text-right font-mono tabular whitespace-nowrap ${
                        v < 0 ? "text-danger" : ""
                      }`}
                    >
                      {money(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                <td className="px-3 py-2">{t("total")}</td>
                {[
                  stmt.summary.incomeCents,
                  stmt.summary.costCents,
                  stmt.summary.expensesCents,
                  ...(co ? [stmt.summary.incomeTaxCents] : []),
                  stmt.summary.resultCents,
                  ...(co ? [stmt.summary.oriCents] : []),
                ].map((v, i) => (
                  <td key={i} className="px-3 py-2 text-right font-mono tabular whitespace-nowrap">
                    {money(v)}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </ReportShell>
  );
}
