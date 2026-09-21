"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import type { GeneralLedgerAccount } from "@/lib/erp/reports/generalLedger";
import { formatVoucherNumber } from "@/lib/erp/reports/generalLedger";
import { fmtIsoDate } from "../_components/fmt";

/**
 * Tabla del libro mayor (portado de zenith `mayor/mayor-table.tsx`):
 * una fila por cuenta con Debe / Haber / Balance, desplegable para ver
 * «Saldo inicial al período» y los movimientos con saldo corrido.
 * El estado de plegado es local (no viaja en la URL: son muchas cuentas).
 */
export function GeneralLedgerView({
  accounts,
  totals,
  currency,
}: {
  accounts: GeneralLedgerAccount[];
  totals: { debitCents: number; creditCents: number };
  currency: string;
}) {
  const t = useTranslations("opReportes");
  const tErp = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [open, setOpen] = useState<Set<string>>(() => new Set(accounts.length === 1 ? [accounts[0]!.code] : []));
  const money = (c: number) => formatMoney(c, { currency, locale });
  const sourceLabel = (s: string) => (tErp.has(`jSource_${s}`) ? tErp(`jSource_${s}`) : s);
  const allOpen = accounts.length > 0 && accounts.every((a) => open.has(a.code));

  function toggle(code: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  const th = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
  const num = "px-3 py-1.5 text-right font-mono tabular whitespace-nowrap";

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      <div className="no-print flex items-center justify-end gap-2 border-b border-op-border bg-op-bg px-3 py-2">
        <button
          type="button"
          className="mp-btn mp-btn--ghost mp-btn--sm"
          onClick={() => setOpen(allOpen ? new Set() : new Set(accounts.map((a) => a.code)))}
        >
          {allOpen ? t("collapseAll") : t("expandAll")}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-op-border text-op-muted">
              <th className={`${th} text-left`}>{t("colAccount")}</th>
              <th className={`${th} text-right`}>{t("colDebit")}</th>
              <th className={`${th} text-right`}>{t("colCredit")}</th>
              <th className={`${th} text-right`}>{t("colBalance")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-op-border/50">
            {accounts.map((a) => {
              const isOpen = open.has(a.code);
              return (
                <AccountRows
                  key={a.code}
                  account={a}
                  isOpen={isOpen}
                  onToggle={() => toggle(a.code)}
                  money={money}
                  sourceLabel={sourceLabel}
                  locale={locale}
                  numCls={num}
                />
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
              <td className="px-3 py-2">{t("total")}</td>
              <td className={num}>{money(totals.debitCents)}</td>
              <td className={num}>{money(totals.creditCents)}</td>
              <td className={num} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function AccountRows({
  account: a,
  isOpen,
  onToggle,
  money,
  sourceLabel,
  locale,
  numCls,
}: {
  account: GeneralLedgerAccount;
  isOpen: boolean;
  onToggle: () => void;
  money: (c: number) => string;
  sourceLabel: (s: string) => string;
  locale: Locale;
  numCls: string;
}) {
  const t = useTranslations("opReportes");
  return (
    <>
      <tr className="font-medium">
        <td className="px-3 py-1.5 min-w-0">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            className="flex items-center gap-2 min-w-0 text-left w-full"
          >
            <span
              aria-hidden
              className={`no-print inline-block text-op-muted transition-transform ${isOpen ? "rotate-90" : ""}`}
            >
              ›
            </span>
            <span className="font-mono text-xs text-op-muted shrink-0">{a.code}</span>
            <span className="truncate">{a.name}</span>
            <span className="ml-auto shrink-0 text-xs text-op-muted font-normal">
              {t("glMovements", { n: a.movements.length })}
            </span>
          </button>
        </td>
        <td className={numCls}>{money(a.debitCents)}</td>
        <td className={numCls}>{money(a.creditCents)}</td>
        <td className={`${numCls} font-semibold`}>{money(a.balanceCents)}</td>
      </tr>
      <tr className={isOpen ? "" : "report-row-hidden"} hidden={!isOpen}>
        <td colSpan={4} className="p-0 bg-op-bg/40">
          <div className="px-3 py-2 sm:pl-10">
            <div className="flex items-center justify-between gap-3 text-xs text-op-muted py-1">
              <span>{t("glInitial")}</span>
              <span className="font-mono tabular">{money(a.initialCents)}</span>
            </div>
            {a.movements.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[560px]">
                  <thead>
                    <tr className="text-op-muted">
                      <th className="px-2 py-1 text-left font-normal">{t("colDate")}</th>
                      <th className="px-2 py-1 text-left font-normal">{t("colVoucher")}</th>
                      <th className="px-2 py-1 text-left font-normal">{t("colDescription")}</th>
                      <th className="px-2 py-1 text-right font-normal">{t("colDebit")}</th>
                      <th className="px-2 py-1 text-right font-normal">{t("colCredit")}</th>
                      <th className="px-2 py-1 text-right font-normal">{t("colRunning")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-op-border/40">
                    {a.movements.map((m) => (
                      <tr key={m.id} className={m.voided ? "opacity-60" : ""}>
                        <td className="px-2 py-1 whitespace-nowrap">{fmtIsoDate(m.date, locale)}</td>
                        <td className="px-2 py-1 font-mono whitespace-nowrap">
                          {formatVoucherNumber(m.voucherNumber) ?? (
                            <span className="text-op-muted">{t("unnumbered")}</span>
                          )}
                        </td>
                        <td className="px-2 py-1 min-w-0">
                          <span className="mr-2 inline-block rounded-full border border-op-border px-1.5 text-[10px] text-op-muted">
                            {sourceLabel(m.source)}
                          </span>
                          {m.voided && (
                            <span className="mr-2 inline-block rounded-full bg-danger/10 px-1.5 text-[10px] font-semibold text-danger">
                              {t("voided")}
                            </span>
                          )}
                          {m.memo}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular whitespace-nowrap">
                          {m.debitCents ? money(m.debitCents) : ""}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular whitespace-nowrap">
                          {m.creditCents ? money(m.creditCents) : ""}
                        </td>
                        <td className="px-2 py-1 text-right font-mono tabular whitespace-nowrap">
                          {money(m.runningCents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </td>
      </tr>
    </>
  );
}
