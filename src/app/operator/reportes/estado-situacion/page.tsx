import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import {
  BALANCE_SHEET_FROM,
  buildBalanceSheet,
  openPeriodStart,
  type BalanceSheetRow,
} from "@/lib/erp/reports/balanceSheet";
import { balanceSheetQuery, cutoffFromQuery } from "@/lib/erp/reports/params";
import { periodToUtcRange, todayIso } from "@/lib/erp/reports/period";
import {
  loadBalancesThrough,
  loadClosingDates,
  loadReportAccounts,
} from "@/lib/erp/reports/queries";
import { drilldownHref } from "../_components/drilldown";
import { fmtIsoDate, fmtIsoDateNumeric } from "../_components/fmt";
import { firstParam, reportGate } from "../_components/gate";
import { PrintButton } from "../_components/PrintButton";
import {
  CsvButton,
  csvHref,
  FilterField,
  ReportCheck,
  ReportFilterForm,
  ReportShell,
  StatTile,
} from "../_components/ReportShell";
import { StatementTree, type TreeRow } from "../_components/StatementTree";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * ESTADO DE SITUACIÓN FINANCIERA (ESFA) a una FECHA DE CORTE.
 *
 * El balance es acumulativo desde el comienzo, así que la fecha es un
 * «hasta»: `?corte=yyyy-mm-dd` (inclusivo; por defecto HOY). Se calcula
 * en el servidor con la misma librería que la API y el CSV lo sirve la
 * API con el mismo corte. El criterio contable (universo con asientos de
 * cierre, utilidad al vuelo del período abierto) vive documentado y
 * probado en `balanceSheet.ts` / `balanceSheet.test.ts`.
 *
 * Tres árboles PUC (activo | pasivo | patrimonio con la línea de
 * utilidad), cada uno con su plegado en la URL (`abrir_activo`…), la fila
 * «Total pasivo + patrimonio» y la verificación de cuadre. Cada cuenta
 * enlaza a su detalle con el mismo universo (desde 1900 hasta el corte).
 */
export default async function EstadoSituacionPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tSettings, locale] = await Promise.all([
    getTranslations("opReportes"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const sp = await searchParams;
  // En la página se es tolerante: un corte inválido se ignora (→ hoy).
  const parsed = balanceSheetQuery.safeParse(
    Object.fromEntries(Object.entries({ corte: firstParam(sp.corte) }).filter(([, v]) => v)),
  );
  const cutoff = cutoffFromQuery(parsed.success ? parsed.data : {}, todayIso());
  const { to } = periodToUtcRange({ desde: cutoff, hasta: cutoff });

  const [balances, accounts, closings] = await Promise.all([
    loadBalancesThrough(gate.restaurantId, to),
    loadReportAccounts(gate.restaurantId),
    loadClosingDates(gate.restaurantId),
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

  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const cutoffLabel = t("bsCutoffLabel", { date: fmtIsoDate(cutoff, loc) });
  const postable = new Set(accounts.filter((a) => a.postable).map((a) => a.code));
  const toTree = (r: BalanceSheetRow): TreeRow => ({
    key: r.key,
    code: r.code,
    name: r.name,
    depth: r.depth,
    ancestors: r.ancestors,
    hasChildren: r.hasChildren,
    values: [r.valueCents],
    variant: r.hasChildren ? "group" : "line",
    emphasis: r.emphasis,
    href: r.synthetic
      ? undefined
      : drilldownHref({
          code: r.code,
          postable: postable.has(r.code),
          desde: BALANCE_SHEET_FROM,
          hasta: cutoff,
        }),
  });
  const keep = {
    abrir_activo: firstParam(sp.abrir_activo),
    abrir_pasivo: firstParam(sp.abrir_pasivo),
    abrir_patrimonio: firstParam(sp.abrir_patrimonio),
  };
  const inputCls = "w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";

  const section = (
    key: "activo" | "pasivo" | "patrimonio",
    title: string,
    totalLabel: string,
  ) => (
    <section className="space-y-2">
      <h2 className="text-[11px] uppercase tracking-wider text-op-muted">{title}</h2>
      <StatementTree
        rows={bs.sections[key].rows.map(toTree)}
        columns={[t("colRunning")]}
        totals={[bs.sections[key].totalCents]}
        totalLabel={totalLabel}
        currency={gate.currency}
        firstColumnLabel={t("colAccount")}
        param={`abrir_${key}`}
        empty={t("bsEmptySection")}
      />
    </section>
  );

  return (
    <ReportShell
      title={t("bsTitle")}
      description={t("bsSubtitle")}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("bsTitle"),
        subtitle: cutoffLabel,
      }}
      filters={
        <ReportFilterForm keep={keep} note={t("bsFilterNote")}>
          <FilterField label={t("bsCutoff")}>
            <input type="date" name="corte" defaultValue={cutoff} className={inputCls} />
          </FilterField>
        </ReportFilterForm>
      }
      actions={
        <>
          <CsvButton href={csvHref("/api/operator/reports/balance-sheet", { corte: cutoff })} />
          <PrintButton />
        </>
      }
      stats={
        <>
          <StatTile label={t("bsTotalActivo")} value={money(bs.totals.activoCents)} />
          <StatTile label={t("bsTotalPasivo")} value={money(bs.totals.pasivoCents)} />
          <StatTile label={t("bsTotalPatrimonio")} value={money(bs.totals.totalPatrimonioCents)} />
        </>
      }
      note={t("bsNote")}
    >
      <div className="text-sm text-op-muted">{cutoffLabel}</div>

      <div className="grid gap-4 lg:grid-cols-2">
        {section("activo", t("bsActivo"), t("bsTotalActivo"))}
        <div className="space-y-4">
          {section("pasivo", t("bsPasivo"), t("bsTotalPasivo"))}
          {section("patrimonio", t("bsPatrimonio"), t("bsTotalPatrimonio"))}
          {/* Fila de CUADRE: la que confirma de un vistazo que el balance cierra. */}
          <div className="flex items-baseline justify-between gap-4 rounded-xl border border-op-border bg-op-surface px-4 py-3 text-sm font-semibold">
            <span>{t("bsTotalPasivoPatrimonio")}</span>
            <span className="font-mono tabular whitespace-nowrap">
              {money(bs.totals.totalPasivoPatrimonioCents)}
            </span>
          </div>
        </div>
      </div>

      <ReportCheck
        description={t("bsBalancedDesc", {
          activo: money(bs.totals.activoCents),
          total: money(bs.totals.totalPasivoPatrimonioCents),
        })}
        ok={bs.balanced}
        failLabel={t("unbalanced", { amount: money(Math.abs(bs.totals.differenceCents)) })}
      />
    </ReportShell>
  );
}
