"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { InvIcon } from "./InventoryIcons";
import { countStageKey, type CountSummary } from "./types";

/**
 * Pestaña Conteos: sesiones recientes primero, de a 20 con «Cargar más»
 * (antes se cortaban en 20 sin avisar). Una fila por sesión en escritorio,
 * tarjetas en el celular; tocar la sesión la abre.
 */
export function CountsTab({
  version,
  openingId,
  onNew,
  onOpen,
}: {
  /** Sube cuando se crea, cierra o borra un conteo. */
  version: number;
  openingId: string | null;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [counts, setCounts] = useState<CountSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/stock/counts");
        if (!r.ok) throw new Error("load_failed");
        const j = await r.json();
        if (cancelled) return;
        setCounts((j.counts ?? []) as CountSummary[]);
        setNextCursor(j.nextCursor ?? null);
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version, retry]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(`/api/operator/stock/counts?cursor=${encodeURIComponent(nextCursor)}`);
      if (!r.ok) throw new Error("load_failed");
      const j = await r.json();
      setCounts((prev) => [...(prev ?? []), ...((j.counts ?? []) as CountSummary[])]);
      setNextCursor(j.nextCursor ?? null);
    } catch {
      setError(true);
    }
    setLoadingMore(false);
  }

  const stagePill = (c: CountSummary) => (
    <span className={"mp-inv-pill shrink-0" + (c.status === "draft" ? " mp-inv-pill--ink" : "")}>{t(countStageKey(c))}</span>
  );

  return (
    <div className="space-y-3">
      <div className="mp-inv-toolbar">
        <p className="mr-auto text-sm text-op-muted">{t("countsIntro")}</p>
        <button type="button" onClick={onNew} className="mp-btn mp-btn--primary mp-btn--sm">
          <InvIcon name="plus" />
          {t("newCount")}
        </button>
      </div>

      <div className="mp-inv-card">
        {error ? (
          <div className="p-6 text-sm text-danger">
            {t("errLoadFailed")}{" "}
            <button type="button" onClick={() => { setError(false); setCounts(null); setRetry((n) => n + 1); }} className="underline">
              {t("retry")}
            </button>
          </div>
        ) : counts === null ? (
          <div className="py-8 text-center text-sm text-op-muted">{t("loading")}</div>
        ) : counts.length === 0 ? (
          <div className="p-8 text-center text-sm text-op-muted">{t("countsEmpty")}</div>
        ) : (
          <>
            <div className="mp-inv-summary">
              <span>{t(nextCursor ? "countsLoadedSome" : "countsLoadedAll", { count: counts.length })}</span>
            </div>
            <div className="@container hidden md:block overflow-x-auto">
              <table className="mp-inv-table">
                <thead>
                  <tr>
                    <th scope="col" className="text-left mp-inv-sticky">{t("countColDate")}</th>
                    <th scope="col" className="text-left">{t("countColStatus")}</th>
                    <th scope="col" className="text-right">{t("countColItems")}</th>
                    <th scope="col" className="text-left">{t("countColBy")}</th>
                    <th scope="col" className="text-left hidden @3xl:table-cell">{t("countColNotes")}</th>
                    <th scope="col" className="text-left hidden @4xl:table-cell">{t("countColClosed")}</th>
                    <th scope="col" className="w-24"><span className="sr-only">{t("invColActions")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {counts.map((c) => (
                    <tr key={c.id}>
                      <td className="mp-inv-sticky mp-inv-namecell">
                        <span className="mp-inv-name tabular-nums">{formatDate(c.createdAt, { locale })}</span>
                      </td>
                      <td>{stagePill(c)}</td>
                      <td className="text-right tabular-nums">{c._count.items}</td>
                      <td className="text-op-muted"><span className="block max-w-[12rem] truncate">{c.createdBy?.name ?? "—"}</span></td>
                      <td className="hidden @3xl:table-cell text-op-muted">
                        <span className="block max-w-[18rem] truncate" title={c.notes ?? undefined}>{c.notes ?? "—"}</span>
                      </td>
                      <td className="hidden @4xl:table-cell text-op-muted tabular-nums">{c.closedAt ? formatDate(c.closedAt, { locale }) : "—"}</td>
                      <td className="text-right">
                        <button
                          type="button"
                          onClick={() => onOpen(c.id)}
                          disabled={openingId !== null}
                          aria-label={t("countOpenNamed", { date: formatDate(c.createdAt, { locale }) })}
                          className="mp-btn mp-btn--secondary mp-btn--sm"
                        >
                          {openingId === c.id ? t("loading") : t(c.status === "draft" ? "countContinue" : "countView")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="md:hidden divide-y divide-op-border">
              {counts.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(c.id)}
                    disabled={openingId !== null}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-op-bg disabled:opacity-60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="mp-inv-name text-sm tabular-nums">{formatDate(c.createdAt, { locale })}</span>
                        {stagePill(c)}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-op-muted">
                        {[t("countItems", { count: c._count.items }), c.createdBy?.name ?? null, c.notes].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <span className="shrink-0 text-sm text-op-muted">{openingId === c.id ? t("loading") : <InvIcon name="chevronRight" />}</span>
                  </button>
                </li>
              ))}
            </ul>
            {nextCursor && (
              <div className="mp-pager">
                <span className="mp-pager__info">{t("countsLoadedSome", { count: counts.length })}</span>
                <button type="button" onClick={loadMore} disabled={loadingMore} className="mp-btn mp-btn--secondary mp-btn--sm">
                  {loadingMore ? t("loading") : t("loadMore")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
