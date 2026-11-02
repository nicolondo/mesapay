"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
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

/** Asientos de un día (fecha UTC "YYYY-MM-DD"), con su total debitado. */
type DayGroup = { day: string; entries: Entry[]; totalDebit: number };

/**
 * Agrupa los asientos del mes por día. El día es el de la FECHA del asiento
 * leída en UTC, la misma convención del libro: los asientos diarios del
 * motor van a la medianoche de Bogotá (05:00Z) y los mensuales al último
 * instante UTC del mes, así que ambos caen en su día calendario.
 */
function groupByDay(entries: Entry[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const e of entries) {
    const day = e.date.slice(0, 10);
    const g = groups.get(day) ?? { day, entries: [], totalDebit: 0 };
    g.entries.push(e);
    g.totalDebit += e.lines.reduce((s, l) => s + l.debitCents, 0);
    groups.set(day, g);
  }
  return [...groups.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Libro Diario (Fase 2): asientos generados por el motor, un resumen por
 * día de negocio y por origen (y uno al mes para nómina, depreciación y
 * diferidos), agrupados por fecha. Los meses abiertos se regeneran solos
 * cada día (cron accounting-daily); "Generar/actualizar" recalcula ya a
 * partir de la operación (idempotente).
 */
export function DiarioTab({
  month,
  currency,
}: {
  month: string;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const tc = useTranslations("opComprobantes");
  const locale = useLocale() as Locale;
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  // La corrida diaria (o otra pestaña) está regenerando este comercio.
  const [lockBusy, setLockBusy] = useState(false);
  // Última corrida del motor en el mes (ISO) — botón o corrida diaria.
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null);
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
        setLastGeneratedAt((j.lastGeneratedAt as string | null) ?? null);
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
    setLockBusy(false);
    try {
      const r = await fetch(
        `/api/operator/accounting/journal?month=${month}`,
        { method: "POST" },
      );
      if (r.status === 409) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        if (j?.error === "busy") {
          setLockBusy(true);
          setBusy(false);
          return;
        }
      }
      if (!r.ok) throw new Error("gen");
      const j = await r.json();
      setEntries(j.entries as Entry[]);
      setLastGeneratedAt((j.lastGeneratedAt as string | null) ?? null);
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
  // Cabecera del día: la fecha del asiento leída en UTC (igual que en
  // Comprobantes), sin hora.
  const dayLabel = (day: string) =>
    formatDate(`${day}T00:00:00.000Z`, { locale, timeZone: "UTC", dateStyle: "full", timeStyle: undefined });
  const days = useMemo(() => (entries ? groupByDay(entries) : []), [entries]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs text-op-muted">{t("journalIntro")}</p>
          {/* Tras cargar (así un mes cerrado no parpadea con la nota). */}
          {entries !== null && !monthClosed && (
            <p className="text-xs text-op-muted">{t("journalAutoNote")}</p>
          )}
          {lastGeneratedAt && (
            <p className="text-xs text-op-muted">
              {t("journalLastUpdated", {
                when: formatDate(lastGeneratedAt, { locale }),
              })}
            </p>
          )}
        </div>
        <span className="flex gap-3 shrink-0">
          {/* Cierre por mes con la vista del año entero (numeración, candado,
              cierre del ejercicio). Los controles de acá siguen funcionando. */}
          <Link
            href="/operator/contabilidad/cierre"
            className="text-xs font-medium text-op-accent hover:underline"
          >
            {t("periodCloseLink")}
          </Link>
          {/* Libro completo (todos los meses, manuales, detalle y export). */}
          <Link
            href="/operator/contabilidad/comprobantes"
            className="text-xs font-medium text-op-accent hover:underline"
          >
            {tc("viewAll")}
          </Link>
        </span>
      </div>
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
      {lockBusy && (
        <div className="text-sm text-op-muted">{t("journalBusy")}</div>
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
        <div className="space-y-4">
          {days.map((g) => (
            // Un grupo plegable por día: cabecera con la fecha, cuántos
            // asientos y el total del día; adentro, los asientos como siempre.
            <details key={g.day} open className="group">
              <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 rounded-xl border border-op-border bg-op-bg px-4 py-2 marker:content-none">
                <span className="min-w-0 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold capitalize">{dayLabel(g.day)}</span>
                  <span className="text-xs text-op-muted">{t("jDayCount", { n: g.entries.length })}</span>
                </span>
                <span className="font-mono tabular text-xs text-op-muted shrink-0">
                  {money(g.totalDebit)}
                </span>
              </summary>
              <div className="mt-2 space-y-3 pl-0 sm:pl-3">
                {g.entries.map((e) => {
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
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
