"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";

type Line = { code: string; name: string; amountCents: number };
type TrialRow = {
  code: string;
  name: string;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
};
type Statements = {
  trial: {
    rows: TrialRow[];
    totalDebitCents: number;
    totalCreditCents: number;
    balanced: boolean;
  };
  income: {
    ingresosCents: number;
    costosCents: number;
    gastosCents: number;
    utilidadBrutaCents: number;
    utilidadOperacionalCents: number;
    ingresos: Line[];
    costos: Line[];
    gastos: Line[];
  };
  balance: {
    activoCents: number;
    pasivoCents: number;
    patrimonioCents: number;
    resultadoCents: number;
    patrimonioTotalCents: number;
    balanced: boolean;
    activo: Line[];
    pasivo: Line[];
    patrimonio: Line[];
  };
};

/**
 * Estados contables (Fase 3): estado de resultados, situación financiera y
 * balance de comprobación — todo derivado del Libro Diario del mes.
 */
export function EstadosTab({
  month,
  currency,
}: {
  month: string;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [st, setSt] = useState<Statements | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/operator/accounting/statements?month=${month}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setSt(j.statements as Statements);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, [month]);

  const money = (c: number) => formatMoney(c, { currency, locale });

  if (err) return <div className="text-sm text-danger">{t("stError")}</div>;
  if (!st) return <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>;

  return (
    <div className="space-y-4">
      <p className="text-xs text-op-muted">{t("stIntro")}</p>

      {/* Estado de Resultados */}
      <Section title={t("stIncome")}>
        <Rows lines={st.income.ingresos} money={money} />
        <Total label={t("stIngresos")} value={money(st.income.ingresosCents)} />
        <Rows lines={st.income.costos} money={money} sign={-1} />
        <Total label={t("stCostos")} value={money(-st.income.costosCents)} />
        <Total
          label={t("stUtilidadBruta")}
          value={money(st.income.utilidadBrutaCents)}
          strong
        />
        <Rows lines={st.income.gastos} money={money} sign={-1} />
        <Total label={t("stGastos")} value={money(-st.income.gastosCents)} />
        <Total
          label={t("stUtilidadOper")}
          value={money(st.income.utilidadOperacionalCents)}
          strong
        />
      </Section>

      {/* Estado de Situación Financiera */}
      <Section
        title={t("stBalance")}
        badge={st.balance.balanced ? t("stBalancedOk") : t("stUnbalanced")}
        badgeOk={st.balance.balanced}
      >
        <SubHead>{t("stActivo")}</SubHead>
        <Rows lines={st.balance.activo} money={money} />
        <Total label={t("stActivoTotal")} value={money(st.balance.activoCents)} strong />
        <SubHead>{t("stPasivo")}</SubHead>
        <Rows lines={st.balance.pasivo} money={money} />
        <Total label={t("stPasivoTotal")} value={money(st.balance.pasivoCents)} />
        <SubHead>{t("stPatrimonio")}</SubHead>
        <Rows lines={st.balance.patrimonio} money={money} />
        <Total label={t("stResultado")} value={money(st.balance.resultadoCents)} />
        <Total
          label={t("stPatrimonioTotal")}
          value={money(st.balance.patrimonioTotalCents)}
          strong
        />
        <Total
          label={t("stPasivoPatrimonio")}
          value={money(st.balance.pasivoCents + st.balance.patrimonioTotalCents)}
          strong
        />
      </Section>

      {/* Balance de comprobación */}
      <Section
        title={t("stTrial")}
        badge={st.trial.balanced ? t("stBalancedOk") : t("stUnbalanced")}
        badgeOk={st.trial.balanced}
      >
        {st.trial.rows.length === 0 ? (
          <div className="px-4 py-4 text-sm text-op-muted">{t("stEmpty")}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-op-muted">
                <th className="px-3 py-1.5" />
                <th className="px-2 py-1.5 text-left font-mono text-[9px] font-normal uppercase tracking-wider">
                  {t("jAccount")}
                </th>
                <th className="px-3 py-1.5 text-right font-mono text-[9px] font-normal uppercase tracking-wider">
                  {t("jDebit")}
                </th>
                <th className="px-3 py-1.5 text-right font-mono text-[9px] font-normal uppercase tracking-wider">
                  {t("jCredit")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-op-border/50">
              {st.trial.rows.map((r) => (
                <tr key={r.code}>
                  <td className="px-3 py-1.5 font-mono text-xs text-op-muted tabular w-16">
                    {r.code}
                  </td>
                  <td className="px-2 py-1.5 min-w-0">{r.name}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular">
                    {r.debitCents ? money(r.debitCents) : ""}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular">
                    {r.creditCents ? money(r.creditCents) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-op-border font-medium">
                <td className="px-3 py-2" colSpan={2}>
                  {t("stTotales")}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular">
                  {money(st.trial.totalDebitCents)}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular">
                  {money(st.trial.totalCreditCents)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </Section>
    </div>
  );
}

function Section({
  title,
  badge,
  badgeOk,
  children,
}: {
  title: string;
  badge?: string;
  badgeOk?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-op-border bg-op-bg px-4 py-2">
        <span className="font-display text-lg">{title}</span>
        {badge && (
          <span
            className={
              "font-mono text-[10px] uppercase tracking-wider " +
              (badgeOk ? "text-ok" : "text-danger")
            }
          >
            {badge}
          </span>
        )}
      </div>
      <div className="py-1">{children}</div>
    </div>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 pt-3 pb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-op-muted">
      {children}
    </div>
  );
}

function Rows({
  lines,
  money,
  sign = 1,
}: {
  lines: Line[];
  money: (c: number) => string;
  sign?: number;
}) {
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((l) => (
        <div
          key={l.code}
          className="flex items-baseline justify-between gap-3 px-4 py-1 text-sm"
        >
          <span className="min-w-0 truncate text-op-muted">
            <span className="font-mono text-xs tabular mr-2">{l.code}</span>
            {l.name}
          </span>
          <span className="shrink-0 font-mono tabular">
            {money(sign * l.amountCents)}
          </span>
        </div>
      ))}
    </>
  );
}

function Total({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={
        "flex items-baseline justify-between gap-3 px-4 py-1.5 text-sm " +
        (strong ? "border-t border-op-border/60 font-medium" : "")
      }
    >
      <span>{label}</span>
      <span className="font-mono tabular">{value}</span>
    </div>
  );
}
