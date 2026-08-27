"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import type { Locale } from "@/i18n/config";

type BudgetRow = {
  accountCode: string;
  monthlyCents: number;
  executedCents: number;
};
type Center = { id: string; name: string; active: boolean };

// Etiquetas de los grupos presupuestables (clave i18n por código).
const GROUP_KEYS: Record<string, string> = {
  "41": "budgetGroupIncome",
  "51": "budgetGroupAdmin",
  "52": "budgetGroupSales",
  "53": "budgetGroupNonOp",
  "61": "budgetGroupCogs",
};

/**
 * Presupuesto mensual por grupo PUC vs. lo ejecutado del mes (del libro) +
 * gestión de centros de costos (se asignan en los gastos).
 */
export function PresupuestoTab({
  month,
  currency,
}: {
  month: string;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [rows, setRows] = useState<BudgetRow[] | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [centers, setCenters] = useState<Center[] | null>(null);
  const [newCenter, setNewCenter] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(`/api/operator/accounting/presupuesto?month=${month}`),
      fetch("/api/operator/accounting/centros"),
    ])
      .then(async ([p, c]) => {
        if (!p.ok || !c.ok) throw new Error("load");
        const jp = await p.json();
        const jc = await c.json();
        if (!alive) return;
        setRows(jp.rows as BudgetRow[]);
        setCenters(jc.centers as Center[]);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, [month]);

  const money = (c: number) => formatMoney(c, { currency, locale });

  async function saveBudget() {
    if (!rows) return;
    setBusy(true);
    const year = Number(month.slice(0, 4));
    const body = {
      year,
      rows: rows.map((r) => ({
        accountCode: r.accountCode,
        monthlyCents:
          edits[r.accountCode] != null
            ? Number(edits[r.accountCode]!.replace(/\D/g, "")) * 100
            : r.monthlyCents,
      })),
    };
    const res = await fetch("/api/operator/accounting/presupuesto", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(true);
      return;
    }
    setEdits({});
    const r = await fetch(`/api/operator/accounting/presupuesto?month=${month}`);
    if (r.ok) {
      const j = await r.json();
      setRows(j.rows as BudgetRow[]);
    }
  }

  async function addCenter() {
    if (newCenter.trim().length < 2) return;
    setBusy(true);
    const r = await fetch("/api/operator/accounting/centros", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newCenter.trim() }),
    });
    setBusy(false);
    if (r.ok) {
      setNewCenter("");
      const c = await fetch("/api/operator/accounting/centros");
      if (c.ok) setCenters((await c.json()).centers as Center[]);
    }
  }

  async function toggleCenter(c: Center) {
    setBusy(true);
    await fetch("/api/operator/accounting/centros", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ centerId: c.id, active: !c.active }),
    });
    setBusy(false);
    const cr = await fetch("/api/operator/accounting/centros");
    if (cr.ok) setCenters((await cr.json()).centers as Center[]);
  }

  if (err) return <div className="text-sm text-danger">{t("errLoadFailed")}</div>;
  if (rows === null || centers === null) {
    return <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Presupuesto vs ejecutado */}
      <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
        <div className="border-b border-op-border bg-op-bg px-4 py-2 font-mono text-[10px] tracking-wider uppercase text-op-muted">
          {t("budgetTitle")}
        </div>
        <div className="divide-y divide-op-border/60">
          {rows.map((r) => {
            const budget =
              edits[r.accountCode] != null
                ? Number(edits[r.accountCode]!.replace(/\D/g, "")) * 100
                : r.monthlyCents;
            const pct =
              budget > 0
                ? Math.round((r.executedCents / budget) * 100)
                : null;
            const over = pct != null && pct > 100;
            return (
              <div key={r.accountCode} className="px-4 py-2.5 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm min-w-0 truncate">
                    <span className="font-mono text-xs text-op-muted mr-1.5">
                      {r.accountCode}
                    </span>
                    {t(GROUP_KEYS[r.accountCode] ?? "budgetGroupNonOp")}
                  </span>
                  <MoneyInput
                    value={
                      edits[r.accountCode] ??
                      (r.monthlyCents > 0 ? String(r.monthlyCents / 100) : "")
                    }
                    onChange={(v) =>
                      setEdits((p) => ({ ...p, [r.accountCode]: v }))
                    }
                    ariaLabel={t("budgetMonthly")}
                    placeholder="0"
                    className="w-32 min-h-[36px] px-2 rounded-lg border border-op-border bg-op-bg text-sm text-right"
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-op-muted">
                  <span>
                    {t("budgetExecuted", { amount: money(r.executedCents) })}
                  </span>
                  {pct != null && (
                    <span className={over ? "text-danger font-medium" : ""}>
                      {t("budgetPct", { pct })}
                    </span>
                  )}
                </div>
                {budget > 0 && (
                  <div className="h-1.5 rounded-full bg-op-bg overflow-hidden">
                    <div
                      className={
                        "h-full rounded-full " +
                        (over ? "bg-danger" : "bg-ok")
                      }
                      style={{
                        width: `${Math.min(100, Math.max(2, Math.round((r.executedCents / budget) * 100)))}%`,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="p-3 border-t border-op-border">
          <button
            type="button"
            onClick={saveBudget}
            disabled={busy || Object.keys(edits).length === 0}
            className="mp-btn mp-btn--primary mp-btn--block"
          >
            {busy ? t("saving") : t("budgetSave")}
          </button>
        </div>
      </div>

      {/* Centros de costos */}
      <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-2">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("centersTitle")}
        </div>
        <p className="text-xs text-op-muted">{t("centersIntro")}</p>
        {centers.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span className={c.active ? "" : "opacity-50 line-through"}>
              {c.name}
            </span>
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
