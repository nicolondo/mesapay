"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { LIST_PATH, voucherLabel, type EntryRow } from "./shared";

const PAGE = 50;

const inputCls =
  "min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";

/**
 * Lista del libro de comprobantes. Los filtros (q/desde/hasta) llegan por
 * props desde la URL y el padre remonta el componente (key) cuando cambian,
 * así que el estado arranca limpio y el efecto SÓLO hace fetch (mismo patrón
 * que DiarioTab). "Cargar más" pide la siguiente tanda con el cursor del
 * servidor: cada tanda recorre exactamente el mismo conjunto filtrado.
 */
export function ComprobantesClient({
  currency,
  q,
  desde,
  hasta,
}: {
  currency: string;
  q: string;
  desde: string;
  hasta: string;
}) {
  const t = useTranslations("opComprobantes");
  const tErp = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [rows, setRows] = useState<EntryRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);

  const buildUrl = useCallback(
    (cursor: string | null) => {
      const p = new URLSearchParams({ desde, hasta, limit: String(PAGE) });
      if (q) p.set("q", q);
      if (cursor) p.set("cursor", cursor);
      return `/api/operator/accounting/entries?${p.toString()}`;
    },
    [q, desde, hasta],
  );

  useEffect(() => {
    let alive = true;
    fetch(buildUrl(null))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (!alive) return;
        setRows(j.entries as EntryRow[]);
        setNextCursor((j.nextCursor as string | null) ?? null);
        setTotal(Number(j.total) || 0);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, [buildUrl]);

  async function loadMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    try {
      const r = await fetch(buildUrl(nextCursor));
      if (!r.ok) throw new Error("more");
      const j = await r.json();
      setRows((prev) => {
        const seen = new Set((prev ?? []).map((e) => e.id));
        return [...(prev ?? []), ...(j.entries as EntryRow[]).filter((e) => !seen.has(e.id))];
      });
      setNextCursor((j.nextCursor as string | null) ?? null);
      setTotal(Number(j.total) || 0);
    } catch {
      setErr(true);
    }
    setLoading(false);
  }

  const money = (c: number) => formatMoney(c, { currency, locale });
  const day = (iso: string) =>
    formatDate(iso, { locale, timeZone: "UTC", dateStyle: "medium", timeStyle: undefined });
  const sourceLabel = (source: string) =>
    source === "manual"
      ? t("jSource_manual")
      : tErp.has(`jSource_${source}`)
        ? tErp(`jSource_${source}`)
        : source;

  return (
    <div className="space-y-4">
      {/* Filtros: en el celular, buscador a todo el ancho y debajo dos
          columnas (desde | hasta, Filtrar | Limpiar); en sm+ una fila. */}
      <form
        method="get"
        action={LIST_PATH}
        className="rounded-2xl border border-op-border bg-op-surface p-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end"
      >
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder={t("searchPlaceholder")}
          maxLength={80}
          className={`${inputCls} col-span-2 min-w-0 sm:col-span-1 sm:flex-1 sm:min-w-[12rem]`}
        />
        <label className="flex min-w-0 flex-col gap-1 text-[10px] uppercase tracking-wider text-op-muted">
          {t("from")}
          <input type="date" name="desde" defaultValue={desde} className={`${inputCls} w-full min-w-0`} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-[10px] uppercase tracking-wider text-op-muted">
          {t("to")}
          <input type="date" name="hasta" defaultValue={hasta} className={`${inputCls} w-full min-w-0`} />
        </label>
        <button type="submit" className="mp-btn mp-btn--secondary px-4">
          {t("filter")}
        </button>
        <Link href={LIST_PATH} className="mp-btn mp-btn--ghost px-3">
          {t("clearFilters")}
        </Link>
      </form>

      {err ? (
        <div className="text-sm text-danger">{t("error")}</div>
      ) : rows === null ? (
        <div className="text-sm text-op-muted">{t("loading")}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <p className="text-sm text-op-muted">{t("empty")}</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
          {/* Tabla (md+): el scroll, si hace falta, queda dentro de la tarjeta. */}
          <div className="report-table">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-op-muted bg-op-bg border-b border-op-border">
                  <th className="px-4 py-2 text-left font-mono text-[9px] uppercase tracking-wider font-normal">
                    {t("colNumber")}
                  </th>
                  <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider font-normal">
                    {t("colDate")}
                  </th>
                  <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider font-normal">
                    {t("colThirdParty")}
                  </th>
                  <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider font-normal">
                    {t("colMemo")}
                  </th>
                  <th className="px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider font-normal">
                    {t("colSource")}
                  </th>
                  <th className="px-4 py-2 text-right font-mono text-[9px] uppercase tracking-wider font-normal">
                    {t("colTotal")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-op-border/50">
                {rows.map((e) => {
                  const annulled = e.status === "annulled" || e.annulledAt != null;
                  const href = `${LIST_PATH}/${e.id}`;
                  return (
                    <tr
                      key={e.id}
                      onClick={() => router.push(href)}
                      className={
                        "cursor-pointer hover:bg-op-bg/60 " + (annulled ? "text-op-muted" : "")
                      }
                    >
                      <td className="px-4 py-2 whitespace-nowrap">
                        <Link
                          href={href}
                          onClick={(ev) => ev.stopPropagation()}
                          className="font-mono tabular-nums text-xs font-medium"
                        >
                          {e.voucherNumber != null ? (
                            voucherLabel(e.voucherNumber)
                          ) : (
                            <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium">
                              {t("unnumbered")}
                            </span>
                          )}
                        </Link>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">{day(e.date)}</td>
                      <td className="px-3 py-2 min-w-0 max-w-[14rem] truncate">
                        {e.thirdPartyName ?? "—"}
                      </td>
                      <td className="px-3 py-2 min-w-0 max-w-[22rem]">
                        <span className={"block truncate " + (annulled ? "line-through" : "")}>
                          {e.memo ?? ""}
                        </span>
                        {annulled && (
                          <span className="px-2 h-5 inline-flex items-center rounded-full bg-danger/10 text-danger text-[10px] font-medium">
                            {t("annulled")}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium">
                          {sourceLabel(e.source)}
                        </span>
                        {e.reversalOfId && (
                          <span className="ml-1 px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/10 text-[#7F5A1F] text-[10px] font-medium">
                            {t("reversalBadge")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                        {money(e.totalCents)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Celular: una tarjeta por comprobante (número · fecha, glosa,
              tercero, origen) con el total a la derecha. */}
          <div className="report-cards divide-y divide-op-border/50">
            {rows.map((e) => {
              const annulled = e.status === "annulled" || e.annulledAt != null;
              return (
                <Link
                  key={e.id}
                  href={`${LIST_PATH}/${e.id}`}
                  className={"block px-4 py-3 hover:bg-op-bg/60" + (annulled ? " text-op-muted" : "")}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono tabular-nums text-xs font-medium">
                          {e.voucherNumber != null ? (
                            voucherLabel(e.voucherNumber)
                          ) : (
                            <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium">
                              {t("unnumbered")}
                            </span>
                          )}
                        </span>
                        <span className="text-xs tabular-nums text-op-muted">{day(e.date)}</span>
                      </span>
                      <span className={"mt-0.5 block text-sm" + (annulled ? " line-through" : "")}>
                        {e.memo ?? ""}
                      </span>
                      {e.thirdPartyName && (
                        <span className="block truncate text-xs text-op-muted">{e.thirdPartyName}</span>
                      )}
                      <span className="mt-1 flex flex-wrap gap-1">
                        <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium">
                          {sourceLabel(e.source)}
                        </span>
                        {e.reversalOfId && (
                          <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/10 text-[#7F5A1F] text-[10px] font-medium">
                            {t("reversalBadge")}
                          </span>
                        )}
                        {annulled && (
                          <span className="px-2 h-5 inline-flex items-center rounded-full bg-danger/10 text-danger text-[10px] font-medium">
                            {t("annulled")}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-sm">{money(e.totalCents)}</span>
                  </span>
                </Link>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-op-border bg-op-bg px-4 py-2 text-xs text-op-muted">
            <span className="tabular-nums">
              {t("countOf", { n: rows.length, total: Math.max(total, rows.length) })}
            </span>
            {nextCursor && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loading}
                className="mp-btn mp-btn--ghost mp-btn--sm px-3"
              >
                {loading ? t("loading") : t("loadMore")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
