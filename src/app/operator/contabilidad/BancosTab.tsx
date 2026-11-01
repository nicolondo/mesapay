"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";

type BankLine = {
  id: string;
  date: string;
  description: string;
  amountCents: number;
};
type Rule = { id: string; pattern: string; accountCode: string };
type Account = { code: string; name: string; postable: boolean; type: string };

/**
 * Conciliación bancaria: importar el extracto (CSV), contabilizar cada
 * línea contra una cuenta (o por reglas) o marcarla como ya registrada.
 * Los asientos nacen con fuente "bank" y aparecen en el Libro Diario.
 */
export function BancosTab({ currency }: { currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [lines, setLines] = useState<BankLine[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [err, setErr] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [csv, setCsv] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [lineAccount, setLineAccount] = useState<Record<string, string>>({});
  const [rulePattern, setRulePattern] = useState("");
  const [ruleAccount, setRuleAccount] = useState("");
  /** Cuenta del banco del extracto (auxiliar por banco); "" = la por defecto. */
  const [bankAccount, setBankAccount] = useState("");
  const [defaultBank, setDefaultBank] = useState<string | null>(null);

  async function load() {
    try {
      const [b, c] = await Promise.all([
        fetch("/api/operator/accounting/bank"),
        fetch("/api/operator/accounting/chart"),
      ]);
      if (!b.ok || !c.ok) throw new Error("load");
      const jb = await b.json();
      const jc = await c.json();
      setLines(jb.lines as BankLine[]);
      setRules(jb.rules as Rule[]);
      setDefaultBank((jb.defaultBankAccountCode as string | null) ?? null);
      setAccounts(jc.accounts as Account[]);
    } catch {
      setErr(true);
    }
  }
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/operator/accounting/bank"),
      fetch("/api/operator/accounting/chart"),
    ])
      .then(async ([b, c]) => {
        if (!b.ok || !c.ok) throw new Error("load");
        const jb = await b.json();
        const jc = await c.json();
        if (!alive) return;
        setLines(jb.lines as BankLine[]);
        setRules(jb.rules as Rule[]);
        setDefaultBank((jb.defaultBankAccountCode as string | null) ?? null);
        setAccounts(jc.accounts as Account[]);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Cuentas elegibles para contabilizar contra el banco: hojas de gasto,
  // costo e ingreso (lo típico de un extracto), más otros pasivos/activos.
  const options = useMemo(
    () =>
      accounts.filter(
        (a) => a.postable && ["gasto", "costo", "ingreso"].includes(a.type),
      ),
    [accounts],
  );

  // Cuentas de banco: las imputables del disponible (11xx). Con auxiliares
  // por banco (11100501 Bancolombia…) se elige a cuál pertenece el extracto.
  const bankOptions = useMemo(
    () => accounts.filter((a) => a.postable && a.code.startsWith("11")),
    [accounts],
  );
  const bankCode = bankAccount || defaultBank || "";

  const money = (c: number) => formatMoney(c, { currency, locale });

  async function doImport() {
    if (csv.trim().length < 3) return;
    setBusyId("import");
    setImportMsg(null);
    const r = await fetch("/api/operator/accounting/bank", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv }),
    });
    setBusyId(null);
    if (!r.ok) {
      setErr(true);
      return;
    }
    const j = await r.json();
    setImportMsg(
      [
        t("bankImported", { imported: j.imported, skipped: j.skipped }),
        (j.duplicates ?? 0) > 0 ? t("bankDuplicates", { count: j.duplicates }) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    );
    setCsv("");
    await load();
  }

  async function patch(body: Record<string, unknown>, busyKey: string) {
    setBusyId(busyKey);
    const r = await fetch("/api/operator/accounting/bank", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusyId(null);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setImportMsg(
        j.error === "month_closed"
          ? t("bankMonthClosed")
          : j.error === "account_not_postable"
            ? t("bankAccountNotPostable")
            : j.error === "bank_account_invalid"
              ? t("bankAccountInvalid")
              : t("errSaveFailed"),
      );
      return;
    }
    const j = await r.json().catch(() => ({}));
    if (typeof j.applied === "number") {
      setImportMsg(
        [
          t("bankRulesApplied", {
            applied: j.applied,
            skipped: j.skippedClosed ?? 0,
          }),
          (j.skippedInvalid ?? 0) > 0 ? t("bankRulesInvalid", { count: j.skippedInvalid }) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    }
    await load();
  }

  async function addRule() {
    if (rulePattern.trim().length < 2 || !ruleAccount) return;
    setBusyId("rule");
    const r = await fetch("/api/operator/accounting/bank", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addRule: { pattern: rulePattern.trim(), accountCode: ruleAccount },
      }),
    });
    setBusyId(null);
    if (r.ok) {
      setRulePattern("");
      await load();
    } else {
      const j = await r.json().catch(() => ({}));
      setImportMsg(
        j.error === "account_not_postable" ? t("bankAccountNotPostable") : t("errSaveFailed"),
      );
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-op-muted">{t("bankIntro")}</p>

      {/* Cuenta del banco del extracto: los movimientos se asientan contra
          ella (antes, siempre contra 111005). */}
      {bankOptions.length > 0 && (
        <label className="block rounded-2xl border border-op-border bg-op-surface p-4 space-y-1">
          <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {t("bankAccountLabel")}
          </span>
          <select
            value={bankCode}
            onChange={(e) => setBankAccount(e.target.value)}
            className="w-full min-h-[40px] px-2 rounded-lg border border-op-border bg-op-bg text-sm"
          >
            {bankOptions.map((a) => (
              <option key={a.code} value={a.code}>
                {`${a.code} ${a.name}`}
              </option>
            ))}
          </select>
          <span className="block text-[11px] text-op-muted">{t("bankAccountHint")}</span>
        </label>
      )}

      {/* Importar extracto */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-2">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("bankImportTitle")}
        </div>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={t("bankCsvPlaceholder")}
          rows={4}
          className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-xs font-mono"
        />
        <button
          type="button"
          onClick={doImport}
          disabled={busyId === "import" || csv.trim().length < 3}
          className="mp-btn mp-btn--primary mp-btn--block"
        >
          {busyId === "import" ? t("bankImporting") : t("bankImport")}
        </button>
        {importMsg && <p className="text-xs text-op-muted">{importMsg}</p>}
      </div>

      {/* Reglas */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
            {t("bankRulesTitle")}
          </div>
          <button
            type="button"
            onClick={() =>
              patch({ action: "applyRules", ...(bankCode ? { bankAccountCode: bankCode } : {}) }, "apply")
            }
            disabled={busyId === "apply" || rules.length === 0}
            className="text-[11px] text-terracotta hover:underline disabled:opacity-40"
          >
            {busyId === "apply" ? t("bankApplying") : t("bankApplyRules")}
          </button>
        </div>
        {rules.map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className="min-w-0 truncate">
              <span className="font-mono text-xs bg-op-bg px-1.5 py-0.5 rounded">
                {r.pattern}
              </span>{" "}
              {"→"} <span className="font-mono text-xs">{r.accountCode}</span>
            </span>
            <button
              type="button"
              onClick={() =>
                patch({ action: "deleteRule", ruleId: r.id }, r.id)
              }
              disabled={busyId === r.id}
              className="text-[11px] text-danger hover:underline shrink-0"
            >
              {t("delete")}
            </button>
          </div>
        ))}
        <div className="flex gap-2">
          <input
            value={rulePattern}
            onChange={(e) => setRulePattern(e.target.value)}
            placeholder={t("bankRulePattern")}
            className="flex-1 min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm min-w-0"
          />
          <select
            value={ruleAccount}
            onChange={(e) => setRuleAccount(e.target.value)}
            className="min-h-[40px] px-2 rounded-lg border border-op-border bg-op-bg text-xs max-w-[160px]"
          >
            <option value="">{t("bankChooseAccount")}</option>
            {options.map((a) => (
              <option key={a.code} value={a.code}>
                {`${a.code} ${a.name}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addRule}
            disabled={busyId === "rule"}
            className="mp-btn mp-btn--secondary mp-btn--sm px-3 shrink-0"
          >
            {t("add")}
          </button>
        </div>
      </div>

      {/* Pendientes */}
      {err ? (
        <div className="text-sm text-danger">{t("errLoadFailed")}</div>
      ) : lines === null ? (
        <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>
      ) : lines.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("bankEmpty")}
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          <div className="border-b border-op-border bg-op-bg px-4 py-2 font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("bankPendingCount", { count: lines.length })}
          </div>
          {lines.map((l) => (
            <div
              key={l.id}
              className="px-4 py-2.5 border-b border-op-border last:border-b-0 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm truncate">{l.description}</div>
                  <div className="text-[11px] text-op-muted">
                    {l.date.slice(0, 10)}
                  </div>
                </div>
                <div
                  className={
                    "font-mono tabular text-sm shrink-0 " +
                    (l.amountCents > 0 ? "text-ok" : "")
                  }
                >
                  {money(l.amountCents)}
                </div>
              </div>
              <div className="flex gap-2">
                <select
                  value={lineAccount[l.id] ?? ""}
                  onChange={(e) =>
                    setLineAccount((p) => ({ ...p, [l.id]: e.target.value }))
                  }
                  className="flex-1 min-h-[36px] px-2 rounded-lg border border-op-border bg-op-bg text-xs min-w-0"
                >
                  <option value="">{t("bankChooseAccount")}</option>
                  {options.map((a) => (
                    <option key={a.code} value={a.code}>
                      {`${a.code} ${a.name}`}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() =>
                    patch(
                      {
                        action: "journalize",
                        lineId: l.id,
                        accountCode: lineAccount[l.id],
                        ...(bankCode ? { bankAccountCode: bankCode } : {}),
                      },
                      l.id,
                    )
                  }
                  disabled={busyId === l.id || !lineAccount[l.id]}
                  className="mp-btn mp-btn--secondary mp-btn--sm px-3 shrink-0"
                >
                  {t("bankJournalize")}
                </button>
                <button
                  type="button"
                  onClick={() => patch({ action: "ignore", lineId: l.id }, l.id)}
                  disabled={busyId === l.id}
                  className="mp-chip shrink-0"
                >
                  {t("bankIgnore")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
