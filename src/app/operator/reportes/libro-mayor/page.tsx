import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { buildGeneralLedger } from "@/lib/erp/reports/generalLedger";
import { generalLedgerQuery, periodFromQuery } from "@/lib/erp/reports/params";
import { periodToUtcRange, resolveReportPeriod, todayIso } from "@/lib/erp/reports/period";
import { loadLedgerLines, loadReportAccounts } from "@/lib/erp/reports/queries";
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
import { GeneralLedgerView } from "./GeneralLedgerView";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Libro mayor: todas las cuentas con sus totales del período (Debe /
 * Haber / Balance), desplegables para ver el saldo inicial y los
 * movimientos con saldo corrido. Combobox de cuenta por código o nombre.
 */
export default async function LibroMayorPage({ searchParams }: { searchParams: SearchParams }) {
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
    cuenta: firstParam(sp.cuenta),
  };
  const parsed = generalLedgerQuery.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([, v]) => v)),
  );
  const q = parsed.success ? parsed.data : {};
  const today = todayIso();
  const period = periodFromQuery(q, today) ?? resolveReportPeriod({ today });
  const { from, to } = periodToUtcRange(period);

  const [lines, accounts] = await Promise.all([
    loadLedgerLines(gate.restaurantId, to, q.cuenta),
    loadReportAccounts(gate.restaurantId),
  ]);
  const ledger = buildGeneralLedger(lines, accounts, { from, to, accountCode: q.cuenta });

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const periodLabel = t("periodLabel", {
    from: fmtIsoDate(period.desde, loc),
    to: fmtIsoDate(period.hasta, loc),
  });
  const filterParams = { desde: period.desde, hasta: period.hasta, cuenta: q.cuenta };
  const selected = q.cuenta ? accounts.find((a) => a.code === q.cuenta) : undefined;
  const inputCls = "w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";

  return (
    <ReportShell
      title={t("glTitle")}
      description={t("glSubtitle")}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("glTitle"),
        subtitle: selected ? `${periodLabel} · ${selected.code} ${selected.name}` : periodLabel,
      }}
      filters={
        <ReportFilterForm>
          <ReportPeriod key={`${period.desde}-${period.hasta}`} desde={period.desde} hasta={period.hasta} step="mes" />
          <FilterField label={t("glAccount")}>
            <input
              name="cuenta"
              list="ledger-accounts"
              defaultValue={q.cuenta ?? ""}
              placeholder={t("glAccountPlaceholder")}
              autoComplete="off"
              className={`${inputCls} min-w-[220px]`}
            />
            <datalist id="ledger-accounts">
              {accounts
                .filter((a) => a.postable && a.active)
                .map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} · {a.name}
                  </option>
                ))}
            </datalist>
          </FilterField>
          {q.cuenta && (
            <Link
              href={`/operator/reportes/libro-mayor?desde=${period.desde}&hasta=${period.hasta}`}
              className="mp-btn mp-btn--ghost mp-btn--sm"
            >
              {t("glClear")}
            </Link>
          )}
        </ReportFilterForm>
      }
      actions={
        <>
          <CsvButton href={csvHref("/api/operator/reports/general-ledger", filterParams)} />
          <PrintButton />
        </>
      }
      note={t("glNote")}
    >
      <div className="text-sm text-op-muted">
        {periodLabel}
        {selected && (
          <>
            {" · "}
            <span className="font-mono text-xs">{selected.code}</span> {selected.name}
          </>
        )}
      </div>

      {ledger.accounts.length === 0 ? (
        <EmptyNote>{t("noData")}</EmptyNote>
      ) : (
        <GeneralLedgerView
          accounts={ledger.accounts}
          totals={ledger.totals}
          currency={gate.currency}
        />
      )}

      {!q.cuenta && (
        <ReportCheck
          description={t("balancedDesc", {
            debits: money(ledger.totals.debitCents),
            credits: money(ledger.totals.creditCents),
          })}
          ok={ledger.balanced}
          failLabel={t("unbalanced", {
            amount: money(Math.abs(ledger.totals.debitCents - ledger.totals.creditCents)),
          })}
        />
      )}
    </ReportShell>
  );
}
