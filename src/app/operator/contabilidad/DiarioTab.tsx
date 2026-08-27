"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";

type Line = {
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
};
type Entry = {
  id: string;
  date: string;
  source: string;
  memo: string | null;
  voucherNumber: number | null;
  lines: Line[];
};

/**
 * Libro Diario (Fase 2): asientos-resumen del mes generados por el motor.
 * "Generar/actualizar" recalcula a partir de la operación (idempotente).
 */
export function DiarioTab({
  month,
  currency,
}: {
  month: string;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  // Cierre de período: mes con candado = comprobantes numerados en firme.
  const [monthClosed, setMonthClosed] = useState(false);
  const [closedThrough, setClosedThrough] = useState<string | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);

  // El componente se remonta por mes (key=month en el padre), así que el
  // estado ya arranca limpio — el efecto sólo hace fetch.
  useEffect(() => {
    let alive = true;
    fetch(`/api/operator/accounting/journal?month=${month}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (!alive) return;
        setEntries(j.entries as Entry[]);
        setMonthClosed(Boolean(j.monthClosed));
        setClosedThrough((j.closedThrough as string | null) ?? null);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, [month]);

  async function generate() {
    setBusy(true);
    setErr(false);
    try {
      const r = await fetch(
        `/api/operator/accounting/journal?month=${month}`,
        { method: "POST" },
      );
      if (!r.ok) throw new Error("gen");
      const j = await r.json();
      setEntries(j.entries as Entry[]);
    } catch {
      setErr(true);
    }
    setBusy(false);
  }

  async function doClose(action: "close" | "reopen") {
    if (
      action === "close" &&
      !window.confirm(t("closeConfirm", { month }))
    ) {
      return;
    }
    setCloseBusy(true);
    const r = await fetch("/api/operator/accounting/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        action === "close" ? { action, month } : { action },
      ),
    });
    setCloseBusy(false);
    if (!r.ok) {
      setErr(true);
      return;
    }
    const j = await r.json();
    setClosedThrough((j.closedThrough as string | null) ?? null);
    const ct = (j.closedThrough as string | null) ?? null;
    setMonthClosed(ct != null && month <= ct);
    // Refrescar para ver los números de comprobante recién asignados.
    const jr = await fetch(`/api/operator/accounting/journal?month=${month}`);
    if (jr.ok) {
      const jj = await jr.json();
      setEntries(jj.entries as Entry[]);
    }
  }

  const money = (c: number) => formatMoney(c, { currency, locale });

  return (
    <div className="space-y-3">
      <p className="text-xs text-op-muted">{t("journalIntro")}</p>
      {monthClosed ? (
        <div className="rounded-xl border border-op-border bg-op-bg px-4 py-3 flex items-center justify-between gap-3">
          <span className="text-sm">
            {t("monthClosedBadge", { month: closedThrough ?? month })}
          </span>
          <button
            type="button"
            onClick={() => doClose("reopen")}
            disabled={closeBusy}
            className="mp-btn mp-btn--ghost mp-btn--sm px-3 shrink-0"
          >
            {closeBusy ? t("closeWorking") : t("reopenMonth")}
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="mp-btn mp-btn--primary flex-1"
          >
            {busy ? t("journalGenerating") : t("journalGenerate")}
          </button>
          <button
            type="button"
            onClick={() => doClose("close")}
            disabled={closeBusy || busy || entries === null || entries.length === 0}
            className="mp-btn mp-btn--ghost px-4 shrink-0"
          >
            {closeBusy ? t("closeWorking") : t("closeMonth")}
          </button>
        </div>
      )}
      {err ? (
        <div className="text-sm text-danger">{t("journalError")}</div>
      ) : entries === null ? (
        <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>
      ) : entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <p className="text-sm text-op-muted">{t("journalEmpty")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((e) => {
            const totalDebit = e.lines.reduce((s, l) => s + l.debitCents, 0);
            return (
              <div
                key={e.id}
                className="rounded-2xl border border-op-border bg-op-surface overflow-hidden"
              >
                <div className="flex items-center justify-between gap-2 border-b border-op-border bg-op-bg px-4 py-2">
                  <span className="text-sm font-medium min-w-0 truncate">
                    {e.voucherNumber != null && (
                      <span className="font-mono text-xs text-op-muted mr-2">
                        {t("voucherNo", { n: e.voucherNumber })}
                      </span>
                    )}
                    {t(`jSource_${e.source}`)}
                  </span>
                  <span className="font-mono tabular text-xs text-op-muted">
                    {money(totalDebit)}
                  </span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-op-muted">
                      <th className="px-4 py-1.5 text-left font-mono text-[9px] uppercase tracking-wider" />
                      <th className="px-2 py-1.5 text-left font-mono text-[9px] uppercase tracking-wider font-normal">
                        {t("jAccount")}
                      </th>
                      <th className="px-4 py-1.5 text-right font-mono text-[9px] uppercase tracking-wider font-normal">
                        {t("jDebit")}
                      </th>
                      <th className="px-4 py-1.5 text-right font-mono text-[9px] uppercase tracking-wider font-normal">
                        {t("jCredit")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-op-border/50">
                    {e.lines.map((l, i) => (
                      <tr key={i}>
                        <td className="px-4 py-1.5 font-mono text-xs text-op-muted tabular w-16">
                          {l.accountCode}
                        </td>
                        <td className="px-2 py-1.5 min-w-0">{l.accountName}</td>
                        <td className="px-4 py-1.5 text-right font-mono tabular">
                          {l.debitCents ? money(l.debitCents) : ""}
                        </td>
                        <td className="px-4 py-1.5 text-right font-mono tabular">
                          {l.creditCents ? money(l.creditCents) : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
