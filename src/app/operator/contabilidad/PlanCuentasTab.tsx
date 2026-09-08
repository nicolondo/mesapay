"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

type ImportIssue = {
  line: number;
  code: string;
  reason: string;
};

type Account = {
  code: string;
  name: string;
  type: string;
  nature: string;
  level: number;
  parentCode: string | null;
  postable: boolean;
};

/**
 * Plan de cuentas (PUC NIIF Grupo 2): catálogo jerárquico del comercio, con
 * importación del PUC propio del contador (CSV pegado, aditivo).
 */
export function PlanCuentasTab() {
  const t = useTranslations("opErp");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);

  useEffect(() => {
    let alive = true;
    fetch("/api/operator/accounting/chart")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setAccounts(j.accounts as Account[]);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function runImport() {
    if (csv.trim().length < 3) return;
    setBusy(true);
    setImportMsg(null);
    setIssues([]);
    const res = await fetch("/api/operator/accounting/chart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csv }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setIssues((j.issues as ImportIssue[]) ?? []);
      setImportMsg(
        j.error === "empty" ? t("chartImportEmpty") : t("chartImportFailed"),
      );
      return;
    }
    setIssues((j.issues as ImportIssue[]) ?? []);
    setImportMsg(
      t("chartImportDone", {
        created: j.created ?? 0,
        updated: j.updated ?? 0,
        parents: j.parentsCreated ?? 0,
      }),
    );
    setCsv("");
    const r = await fetch("/api/operator/accounting/chart");
    if (r.ok) setAccounts((await r.json()).accounts as Account[]);
  }

  // Filtro por código/nombre que conserva las agrupadoras padres del match.
  const filtered = useMemo(() => {
    if (!accounts) return [];
    const term = q.trim().toLowerCase();
    if (!term) return accounts;
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const keep = new Set<string>();
    for (const a of accounts) {
      if (a.code.includes(term) || a.name.toLowerCase().includes(term)) {
        keep.add(a.code);
        let p = a.parentCode;
        while (p) {
          keep.add(p);
          p = byCode.get(p)?.parentCode ?? null;
        }
      }
    }
    return accounts.filter((a) => keep.has(a.code));
  }, [accounts, q]);

  if (err) {
    return <div className="text-sm text-danger">{t("cuentasError")}</div>;
  }
  if (!accounts) {
    return <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-op-muted">{t("cuentasIntro")}</p>

      {!importOpen ? (
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="text-[11px] text-terracotta hover:underline"
        >
          {t("chartImportOpen")}
        </button>
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
              {t("chartImportTitle")}
            </div>
            <button
              type="button"
              onClick={() => setImportOpen(false)}
              className="text-[11px] text-op-muted hover:underline shrink-0"
            >
              {t("chartImportClose")}
            </button>
          </div>
          <p className="text-xs text-op-muted">{t("chartImportIntro")}</p>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={t("chartImportPlaceholder")}
            rows={5}
            aria-label={t("chartImportTitle")}
            className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-xs font-mono"
          />
          <button
            type="button"
            onClick={runImport}
            disabled={busy || csv.trim().length < 3}
            className="mp-btn mp-btn--primary mp-btn--block"
          >
            {busy ? t("chartImporting") : t("chartImportCta")}
          </button>
          {importMsg && <p className="text-xs text-op-muted">{importMsg}</p>}
          {issues.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-danger">
                {t("chartImportIssues", { count: issues.length })}
              </p>
              <ul className="space-y-0.5">
                {issues.map((i) => (
                  <li
                    key={`${i.line}-${i.code}`}
                    className="text-[11px] text-op-muted"
                  >
                    <span className="font-mono">
                      {t("chartIssueLine", { line: i.line })}
                    </span>
                    {` · ${i.code} · ${t(ISSUE_KEY[i.reason] ?? "chartIssue_not_numeric")}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t("cuentasSearch")}
        aria-label={t("cuentasSearch")}
        className="w-full min-h-[44px] px-4 rounded-full border border-op-border bg-op-surface text-sm focus:outline-none focus:border-op-text/40"
      />
      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <ul className="divide-y divide-op-border/50">
          {filtered.map((a) => {
            const typeLabel = t(TYPE_KEY[a.type] ?? "ctypeOther");
            const natLabel = a.nature === "debito" ? t("natDebit") : t("natCredit");
            const tag = `${typeLabel} · ${natLabel}`;
            return (
              <li
                key={a.code}
                className="flex items-center gap-2.5 px-3 py-2"
                style={{ paddingLeft: 12 + (a.level - 1) * 14 }}
              >
                {/* Sin ancho fijo: los códigos de un mismo nivel miden igual,
                    así que el nombre queda pegado al código y alineado. */}
                <span
                  className={
                    "font-mono text-xs tabular shrink-0 " +
                    (a.postable ? "text-op-muted" : "text-op-text")
                  }
                >
                  {a.code}
                </span>
                <span
                  className={
                    "flex-1 min-w-0 truncate text-sm " +
                    (a.postable ? "" : "font-medium")
                  }
                >
                  {a.name}
                </span>
                {a.postable && (
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-op-muted">
                    {tag}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

const ISSUE_KEY: Record<string, string> = {
  not_numeric: "chartIssue_not_numeric",
  bad_length: "chartIssue_bad_length",
  bad_class: "chartIssue_bad_class",
  duplicate: "chartIssue_duplicate",
  no_name: "chartIssue_no_name",
};

const TYPE_KEY: Record<string, string> = {
  activo: "ctypeActivo",
  pasivo: "ctypePasivo",
  patrimonio: "ctypePatrimonio",
  ingreso: "ctypeIngreso",
  gasto: "ctypeGasto",
  costo: "ctypeCosto",
};
