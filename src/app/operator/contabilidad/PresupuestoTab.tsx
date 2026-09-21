"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney, localeTag } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import type { Locale } from "@/i18n/config";
import type { BudgetExecutionRow, BudgetStatus } from "@/lib/erp/budgets";
import { fractionDigitsFor, majorToCents } from "./comprobantes/shared";

type Center = { id: string; name: string; active: boolean };
type AccountOption = { code: string; name: string };
type ChartAccount = { code: string; name: string; postable: boolean; active: boolean };
type Execution = { year: number; month: number; rows: BudgetExecutionRow[] };

const inputCls =
  "mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
const labelCls = "font-mono text-[10px] tracking-wider uppercase text-op-muted";
const thCls =
  "px-3 py-1.5 text-left font-mono text-[9px] uppercase tracking-wider font-normal text-op-muted";

/** "2026-09" → "Septiembre de 2026" en el idioma del usuario. */
function periodLabel(month: string, locale: Locale): string {
  const label = formatDate(`${month}-01T12:00:00.000Z`, {
    locale,
    timeZone: "UTC",
    dateStyle: undefined,
    timeStyle: undefined,
    month: "long",
    year: "numeric",
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const STATUS_BAR: Record<BudgetStatus, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  over: "bg-danger",
};
const STATUS_TEXT: Record<BudgetStatus, string> = {
  ok: "text-ok",
  warn: "text-warn",
  over: "text-danger",
};

/**
 * Combobox de cuenta: input con búsqueda por código o nombre sobre los
 * grupos (2 dígitos) y las cuentas imputables activas del plan. Sin
 * librería: lista plegable debajo del input, selección con click.
 */
function AccountCombobox({
  options,
  value,
  onChange,
  placeholder,
  emptyLabel,
  ariaLabel,
}: {
  options: AccountOption[];
  value: AccountOption | null;
  onChange: (next: AccountOption | null) => void;
  placeholder: string;
  emptyLabel: string;
  ariaLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const display = value ? `${value.code} · ${value.name}` : query;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => o.code.startsWith(q) || o.name.toLowerCase().includes(q))
      : options;
    return list.slice(0, 40);
  }, [options, query]);

  return (
    <div className="relative">
      <input
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls="budget-account-listbox"
        aria-autocomplete="list"
        value={display}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        onChange={(e) => {
          onChange(null);
          setQuery(e.target.value);
          setOpen(true);
        }}
        className={inputCls}
      />
      {open && (
        <ul
          id="budget-account-listbox"
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-op-border bg-op-surface shadow-lg text-sm"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-op-muted">{emptyLabel}</li>
          ) : (
            matches.map((o) => (
              <li
                key={o.code}
                role="option"
                aria-selected={value?.code === o.code}
                // mousedown: se ejecuta antes del blur del input, que cierra la lista.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(o);
                  setQuery("");
                  setOpen(false);
                }}
                className={
                  "cursor-pointer px-3 py-2 hover:bg-op-bg" +
                  (o.code.length === 2 ? " font-medium" : "")
                }
              >
                <span className="font-mono text-xs text-op-muted mr-2">{o.code}</span>
                {o.name}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Presupuestos por cuenta y mes (general o por centro de costos) con la
 * ejecución del mes leída del libro, + gestión de centros de costos. El mes
 * lo da el selector compartido de la página.
 */
export function PresupuestoTab({ month, currency }: { month: string; currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const fractionDigits = fractionDigitsFor(currency);
  const [exec, setExec] = useState<Execution | null>(null);
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);
  const [centers, setCenters] = useState<Center[] | null>(null);
  const [newCenter, setNewCenter] = useState("");
  const [loadErr, setLoadErr] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [account, setAccount] = useState<AccountOption | null>(null);
  const [centerId, setCenterId] = useState("");
  const [amount, setAmount] = useState("");
  const [allMonths, setAllMonths] = useState(false);

  const execUrl = `/api/operator/accounting/presupuesto?month=${month}`;

  async function loadExecution(): Promise<void> {
    const r = await fetch(execUrl);
    if (!r.ok) throw new Error("load");
    setExec((await r.json()) as Execution);
  }
  async function loadCenters(): Promise<void> {
    const r = await fetch("/api/operator/accounting/centros");
    if (!r.ok) throw new Error("load");
    setCenters(((await r.json()) as { centers: Center[] }).centers);
  }

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(execUrl),
      fetch("/api/operator/accounting/centros"),
      fetch("/api/operator/accounting/chart"),
    ])
      .then(async ([p, c, ch]) => {
        if (!p.ok || !c.ok || !ch.ok) throw new Error("load");
        const jp = (await p.json()) as Execution;
        const jc = (await c.json()) as { centers: Center[] };
        const jch = (await ch.json()) as { accounts: ChartAccount[] };
        if (!alive) return;
        setExec(jp);
        setCenters(jc.centers);
        // Presupuestables: grupos (2 dígitos) y cuentas imputables activas.
        setAccounts(
          jch.accounts
            .filter((a) => a.active && (a.code.length === 2 || a.postable))
            .map((a) => ({ code: a.code, name: a.name })),
        );
      })
      .catch(() => {
        if (alive) setLoadErr(true);
      });
    return () => {
      alive = false;
    };
  }, [execUrl]);

  const money = (c: number) => formatMoney(c, { currency, locale });
  const pctFmt = useMemo(
    () =>
      new Intl.NumberFormat(localeTag(locale), {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    [locale],
  );
  const errText = (code: string) =>
    t.has(`budgetErr_${code}`) ? t(`budgetErr_${code}`) : t("budgetErr_invalid");
  const period = periodLabel(month, locale);
  const activeCenters = (centers ?? []).filter((c) => c.active);
  const amountCents = majorToCents(amount);
  const canSave = !busy && !!account && amountCents >= 0 && amount !== "";

  async function saveBudget(ev: React.FormEvent) {
    ev.preventDefault();
    if (!canSave || !account) return;
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/operator/accounting/presupuesto", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountCode: account.code,
        costCenterId: centerId || null,
        year: Number(month.slice(0, 4)),
        month: Number(month.slice(5, 7)),
        amountCents,
        allMonths,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(j.error ?? "invalid");
      setBusy(false);
      return;
    }
    setAmount("");
    try {
      await loadExecution();
    } catch {
      setLoadErr(true);
    }
    setBusy(false);
  }

  async function removeBudget(row: BudgetExecutionRow) {
    const name = `${row.accountCode} · ${row.accountName}`;
    if (!window.confirm(t("budgetDeleteConfirm", { name, period }))) return;
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/operator/accounting/presupuesto?id=${encodeURIComponent(row.id)}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(j.error ?? "invalid");
    }
    try {
      await loadExecution();
    } catch {
      setLoadErr(true);
    }
    setBusy(false);
  }

  async function addCenter() {
    if (newCenter.trim().length < 2) return;
    setBusy(true);
    const r = await fetch("/api/operator/accounting/centros", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newCenter.trim() }),
    });
    if (r.ok) {
      setNewCenter("");
      await loadCenters().catch(() => setLoadErr(true));
    }
    setBusy(false);
  }

  async function toggleCenter(c: Center) {
    setBusy(true);
    await fetch("/api/operator/accounting/centros", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ centerId: c.id, active: !c.active }),
    });
    await loadCenters().catch(() => setLoadErr(true));
    setBusy(false);
  }

  if (loadErr) return <div className="text-sm text-danger">{t("errLoadFailed")}</div>;
  if (exec === null || centers === null || accounts === null) {
    return <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-op-muted">{t("budgetIntro")}</p>

      {/* Alta / actualización */}
      <form
        onSubmit={saveBudget}
        className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-3"
      >
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("budgetAddTitle", { period })}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={labelCls}>{t("budgetAccount")}</span>
            <AccountCombobox
              options={accounts}
              value={account}
              onChange={setAccount}
              placeholder={t("budgetAccountSearch")}
              emptyLabel={t("budgetAccountNone")}
              ariaLabel={t("budgetAccount")}
            />
          </label>
          <label className="block">
            <span className={labelCls}>{t("budgetCenter")}</span>
            <select
              value={centerId}
              onChange={(e) => setCenterId(e.target.value)}
              className={inputCls}
            >
              <option value="">{t("budgetCenterGeneral")}</option>
              {activeCenters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>{t("budgetAmount")}</span>
            <MoneyInput
              value={amount}
              onChange={setAmount}
              fractionDigits={fractionDigits}
              ariaLabel={t("budgetAmount")}
              placeholder="0"
              className={inputCls + " text-right"}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allMonths}
            onChange={(e) => setAllMonths(e.target.checked)}
            className="h-4 w-4"
          />
          {t("budgetAllMonths")}
        </label>
        <p className="text-xs text-op-muted">{t("budgetUpsertNote")}</p>
        {err && <div className="text-sm text-danger">{errText(err)}</div>}
        <button type="submit" disabled={!canSave} className="mp-btn mp-btn--primary mp-btn--block">
          {busy ? t("saving") : t("budgetSave")}
        </button>
      </form>

      {/* Ejecución del mes */}
      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="border-b border-op-border bg-op-bg px-4 py-2 font-mono text-[10px] tracking-wider uppercase text-op-muted">
          {t("budgetExecTitle", { period })}
        </div>
        {exec.rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-op-muted">{t("budgetEmpty")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={thCls + " pl-4"}>{t("budgetColAccount")}</th>
                  <th className={thCls}>{t("budgetColCenter")}</th>
                  <th className={thCls + " text-right"}>{t("budgetColBudget")}</th>
                  <th className={thCls + " text-right"}>{t("budgetColActual")}</th>
                  <th className={thCls + " text-right"}>{t("budgetColVariance")}</th>
                  <th className={thCls + " min-w-[140px]"}>{t("budgetColPct")}</th>
                  <th className={thCls + " pr-4"} />
                </tr>
              </thead>
              <tbody>
                {exec.rows.map((r) => (
                  <tr key={r.id} className="border-t border-op-border/60">
                    <td className="px-3 py-2 pl-4">
                      <span className="font-mono text-xs text-op-muted mr-1.5">{r.accountCode}</span>
                      {r.accountName}
                      {r.month === null && (
                        <span className="ml-2 mp-chip text-[10px]">{t("budgetAnnualBadge")}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.costCenterName ?? (
                        <span className="mp-chip text-[10px]">{t("budgetCenterGeneral")}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{money(r.budgetCents)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{money(r.actualCents)}</td>
                    <td
                      className={
                        "px-3 py-2 text-right font-mono tabular-nums " +
                        (r.varianceCents >= 0 ? "text-ok" : "text-danger")
                      }
                    >
                      {money(r.varianceCents)}
                    </td>
                    <td className="px-3 py-2">
                      {r.pct === null || r.status === null ? (
                        <span className="text-op-muted">{"—"}</span>
                      ) : (
                        <div className="space-y-1">
                          <div className={"text-xs font-medium " + STATUS_TEXT[r.status]}>
                            {t("budgetPct", { pct: pctFmt.format(r.pct) })}
                            <span className="ml-1 font-normal text-op-muted">
                              {t(`budgetStatus_${r.status}`)}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-op-bg overflow-hidden">
                            <div
                              className={"h-full rounded-full " + STATUS_BAR[r.status]}
                              style={{ width: `${Math.min(100, Math.max(2, r.pct))}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 pr-4 text-right">
                      <button
                        type="button"
                        onClick={() => removeBudget(r)}
                        disabled={busy}
                        className="mp-chip shrink-0"
                      >
                        {t("delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Centros de costos */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-2">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("centersTitle")}
        </div>
        <p className="text-xs text-op-muted">{t("centersIntro")}</p>
        {centers.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
            <span className={c.active ? "" : "opacity-50 line-through"}>{c.name}</span>
            <button
              type="button"
              onClick={() => toggleCenter(c)}
              disabled={busy}
              className="mp-chip shrink-0"
            >
              {c.active ? t("centerDeactivate") : t("centerActivate")}
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <input
            value={newCenter}
            onChange={(e) => setNewCenter(e.target.value)}
            placeholder={t("centerNamePlaceholder")}
            className="flex-1 min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm min-w-0"
          />
          <button
            type="button"
            onClick={addCenter}
            disabled={busy || newCenter.trim().length < 2}
            className="mp-btn mp-btn--secondary mp-btn--sm px-4 shrink-0"
          >
            {t("add")}
          </button>
        </div>
      </div>
    </div>
  );
}
