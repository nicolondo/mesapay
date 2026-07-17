"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

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
 * Plan de cuentas (PUC NIIF Grupo 2) — vista de sólo lectura (Fase 1). Muestra
 * el catálogo jerárquico; en fases siguientes se enganchan los asientos.
 */
export function PlanCuentasTab() {
  const t = useTranslations("opErp");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [err, setErr] = useState(false);
  const [q, setQ] = useState("");

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
                className="flex items-center gap-3 px-3 py-2"
                style={{ paddingLeft: 12 + (a.level - 1) * 14 }}
              >
                <span
                  className={
                    "font-mono text-xs tabular shrink-0 " +
                    (a.postable ? "text-op-muted" : "text-op-text")
                  }
                  style={{ width: 64 }}
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

const TYPE_KEY: Record<string, string> = {
  activo: "ctypeActivo",
  pasivo: "ctypePasivo",
  patrimonio: "ctypePatrimonio",
  ingreso: "ctypeIngreso",
  gasto: "ctypeGasto",
  costo: "ctypeCosto",
};
