import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { periodFromQuery, trialBalanceQuery } from "@/lib/erp/reports/params";
import { periodToUtcRange, resolveReportPeriod, todayIso } from "@/lib/erp/reports/period";
import { loadReportAccounts, loadTrialBalanceRows } from "@/lib/erp/reports/queries";
import {
  buildTrialBalance,
  parseTrialBalanceLevel,
  TRIAL_BALANCE_LEVELS,
} from "@/lib/erp/reports/trialBalance";
import { firstParam, reportGate } from "../_components/gate";
import { fmtIsoDate } from "../_components/fmt";
import { PrintButton } from "../_components/PrintButton";
import { ReportPeriod } from "../_components/ReportPeriod";
import {
  CsvButton,
  csvHref,
  EmptyNote,
  FilterField,
  ReportCheck,
  ReportFilterForm,
  ReportShell,
} from "../_components/ReportShell";
import { StatementTree } from "../_components/StatementTree";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const LEVEL_KEY = { 1: "tbLevel1", 2: "tbLevel2", 4: "tbLevel4", 6: "tbLevel6" } as const;

/**
 * Balance de prueba: saldo anterior (todo lo previo al «desde»), débitos
 * y créditos del período y nuevo saldo, por nivel del PUC (clase / grupo /
 * cuenta / subcuenta) y con filtro de cuentas por prefijo. Se calcula en
 * el servidor con la misma librería que la API; el CSV lo sirve la API.
 */
export default async function BalancePruebaPage({ searchParams }: { searchParams: SearchParams }) {
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
    nivel: firstParam(sp.nivel),
    cta1: firstParam(sp.cta1),
    cta2: firstParam(sp.cta2),
  };
  // En la página se es tolerante: lo inválido se ignora en vez de romper.
  const parsed = trialBalanceQuery.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([, v]) => v)),
  );
  const q = parsed.success ? parsed.data : {};
  const today = todayIso();
  const period = periodFromQuery(q, today) ?? resolveReportPeriod({ today });
  const level = parseTrialBalanceLevel(q.nivel);
  const { from, to } = periodToUtcRange(period);

  const [rows, accounts] = await Promise.all([
    loadTrialBalanceRows(gate.restaurantId, from, to),
    loadReportAccounts(gate.restaurantId),
  ]);
  const tb = buildTrialBalance(rows, {
    level,
    accountFrom: q.cta1,
    accountTo: q.cta2,
    accounts,
  });

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const periodLabel = t("periodLabel", {
    from: fmtIsoDate(period.desde, loc),
    to: fmtIsoDate(period.hasta, loc),
  });
  const filterParams = {
    desde: period.desde,
    hasta: period.hasta,
    nivel: String(level),
    cta1: q.cta1,
    cta2: q.cta2,
  };
  const inputCls = "w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";

  return (
    <ReportShell
      title={t("tbTitle")}
      description={t("tbSubtitle")}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("tbTitle"),
        subtitle: `${periodLabel} · ${t(LEVEL_KEY[level])}`,
      }}
      filters={
        <ReportFilterForm keep={{ abrir: firstParam(sp.abrir) }}>
          <ReportPeriod key={`${period.desde}-${period.hasta}`} desde={period.desde} hasta={period.hasta} step="mes" />
          <FilterField label={t("tbLevel")}>
            <select name="nivel" defaultValue={String(level)} className={inputCls}>
              {TRIAL_BALANCE_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {t(LEVEL_KEY[l])}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label={t("tbAccountFrom")}>
            <input
              name="cta1"
              inputMode="numeric"
              pattern="\d{1,10}"
              defaultValue={q.cta1 ?? ""}
              placeholder="1105"
              className={`${inputCls} w-28`}
            />
          </FilterField>
          <FilterField label={t("tbAccountTo")}>
            <input
              name="cta2"
              inputMode="numeric"
              pattern="\d{1,10}"
              defaultValue={q.cta2 ?? ""}
              placeholder="2408"
              className={`${inputCls} w-28`}
            />
          </FilterField>
        </ReportFilterForm>
      }
      actions={
        <>
          <CsvButton href={csvHref("/api/operator/reports/trial-balance", filterParams)} />
          <PrintButton />
        </>
      }
      note={t("tbNote")}
    >
      <div className="text-sm text-op-muted">{periodLabel}</div>

      {tb.rows.length === 0 ? (
        <EmptyNote>{t("noData")}</EmptyNote>
      ) : (
        <StatementTree
          rows={tb.rows.map((r) => ({
            key: r.key,
            code: r.code,
            name: r.name,
            depth: r.depth,
            ancestors: r.ancestors,
            hasChildren: r.hasChildren,
            values: [r.initialCents, r.debitCents, r.creditCents, r.finalCents],
          }))}
          columns={[t("colInitial"), t("colDebits"), t("colCredits"), t("colFinal")]}
          totals={[tb.totals.initialCents, tb.totals.debitCents, tb.totals.creditCents, tb.totals.finalCents]}
          totalLabel={tb.filtered ? t("filteredTotals") : t("total")}
          currency={gate.currency}
          firstColumnLabel={t("colAccount")}
        />
      )}

      {/* El cuadre mide TODO el libro aunque la tabla esté filtrada. */}
      <ReportCheck
        description={t("balancedDesc", {
          debits: money(tb.bookTotals.debitCents),
          credits: money(tb.bookTotals.creditCents),
        })}
        ok={tb.balanced}
        failLabel={t("unbalanced", { amount: money(Math.abs(tb.differenceCents)) })}
      />
    </ReportShell>
  );
}
