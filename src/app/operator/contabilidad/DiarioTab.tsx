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

  // El componente se remonta por mes (key=month en el padre), así que el
  // estado ya arranca limpio — el efecto sólo hace fetch.
  useEffect(() => {
    let alive = true;
    fetch(`/api/operator/accounting/journal?month=${month}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setEntries(j.entries as Entry[]);
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

  const money = (c: number) => formatMoney(c, { currency, locale });

  return (
    <div className="space-y-3">
      <p className="text-xs text-op-muted">{t("journalIntro")}</p>
      <button
        type="button"
        onClick={generate}
        disabled={busy}
        className="mp-btn mp-btn--primary mp-btn--block"
      >
        {busy ? t("journalGenerating") : t("journalGenerate")}
      </button>
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
                  <span className="text-sm font-medium">
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
