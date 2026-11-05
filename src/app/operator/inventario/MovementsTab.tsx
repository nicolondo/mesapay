"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { formatBaseQty } from "@/lib/erp/units";
import { KIND_LABEL_KEYS, WASTE_REASON_KEYS, type MovementRow, type StockRow } from "./types";

/**
 * Pestaña Movimientos: el libro (append-only) más reciente primero, con
 * filtro por insumo (lo usa también «Ver movimientos» del menú de la
 * fila). Se pide de a 30 con cursor y siempre se dice cuántos hay cargados
 * y si quedan más: nada se corta en silencio.
 */
export function MovementsTab({
  ingredients,
  ingredientId,
  onIngredientChange,
  version,
  currency,
}: {
  ingredients: StockRow[];
  ingredientId: string | null;
  onIngredientChange: (id: string | null) => void;
  /** Sube cuando se registra un movimiento: el historial cargado queda viejo. */
  version: number;
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [movements, setMovements] = useState<MovementRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const params = new URLSearchParams();
      if (ingredientId) params.set("ingredientId", ingredientId);
      try {
        const r = await fetch(`/api/operator/stock/movements${params.size ? `?${params}` : ""}`);
        if (!r.ok) throw new Error("load_failed");
        const j = await r.json();
        if (cancelled) return;
        setMovements((j.movements ?? []) as MovementRow[]);
        setNextCursor(j.nextCursor ?? null);
        setError(false);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ingredientId, version, retry]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const params = new URLSearchParams({ cursor: nextCursor });
    if (ingredientId) params.set("ingredientId", ingredientId);
    try {
      const r = await fetch(`/api/operator/stock/movements?${params}`);
      if (!r.ok) throw new Error("load_failed");
      const j = await r.json();
      setMovements((prev) => [...(prev ?? []), ...((j.movements ?? []) as MovementRow[])]);
      setNextCursor(j.nextCursor ?? null);
    } catch {
      setError(true);
    }
    setLoadingMore(false);
  }

  function changeIngredient(id: string | null) {
    setMovements(null);
    setNextCursor(null);
    setError(false);
    onIngredientChange(id);
  }

  const kindLabel = (m: MovementRow) => {
    const labelKey = KIND_LABEL_KEYS[m.kind];
    const reasonKey = m.wasteReason ? WASTE_REASON_KEYS[m.wasteReason] : null;
    return (labelKey ? t(labelKey) : m.kind) + (reasonKey ? ` · ${t(reasonKey)}` : "");
  };
  const noteText = (m: MovementRow) => (m.note === "inventory_tracking_disabled" ? t("stockResetMovementNote") : m.note);
  const qtyText = (m: MovementRow) => (m.qtyBase >= 0 ? "+" : "−") + formatBaseQty(Math.abs(m.qtyBase), m.ingredient.measureKind, locale);
  const valueText = (m: MovementRow) => (m.valueCents >= 0 ? "+" : "−") + formatMoney(Math.abs(m.valueCents), { currency, locale });
  const selected = ingredientId ? ingredients.find((i) => i.id === ingredientId) : null;

  return (
    <div className="space-y-3">
      <div className="mp-inv-toolbar">
        <select
          value={ingredientId ?? ""}
          onChange={(e) => changeIngredient(e.target.value || null)}
          aria-label={t("movFilterIngredient")}
          className="mp-inv-select mp-inv-select--wide"
        >
          <option value="">{t("movAllIngredients")}</option>
          {/* Un insumo filtrado que ya no está en la lista (p. ej. archivado
              sin saldo) sigue apareciendo como opción para poder verlo. */}
          {ingredientId && !selected && <option value={ingredientId}>{movements?.[0]?.ingredient.name ?? ingredientId}</option>}
          {ingredients.map((i) => (
            <option key={i.id} value={i.id}>{i.name}</option>
          ))}
        </select>
        {ingredientId && (
          <button type="button" onClick={() => changeIngredient(null)} className="mp-inv-clear">
            {t("clearFilters")}
          </button>
        )}
      </div>

      <div className="mp-inv-card">
        {error ? (
          <div className="p-6 text-sm text-danger">
            {t("errLoadFailed")}{" "}
            <button type="button" onClick={() => { setError(false); setMovements(null); setRetry((n) => n + 1); }} className="underline">
              {t("retry")}
            </button>
          </div>
        ) : movements === null ? (
          <div className="py-8 text-center text-sm text-op-muted">{t("loading")}</div>
        ) : movements.length === 0 ? (
          <div className="p-8 text-center text-sm text-op-muted">{t(ingredientId ? "movementsEmptyFiltered" : "movementsEmpty")}</div>
        ) : (
          <>
            <div className="mp-inv-summary">
              <span>{t(nextCursor ? "movLoadedSome" : "movLoadedAll", { count: movements.length })}</span>
            </div>

            {/* Escritorio: tabla de una línea por movimiento. */}
            <div className="@container hidden md:block overflow-x-auto">
              <table className="mp-inv-table">
                <thead>
                  <tr>
                    <th scope="col" className="text-left mp-inv-sticky">{t("movColItem")}</th>
                    <th scope="col" className="text-left">{t("movColDate")}</th>
                    <th scope="col" className="text-left">{t("movColKind")}</th>
                    <th scope="col" className="text-right">{t("movColQty")}</th>
                    <th scope="col" className="text-right">{t("movColValue")}</th>
                    <th scope="col" className="text-left hidden @4xl:table-cell">{t("movColBy")}</th>
                    <th scope="col" className="text-left hidden @3xl:table-cell mp-inv-greedy">{t("movColNote")}</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((m) => {
                    const isIn = m.qtyBase >= 0;
                    const note = noteText(m);
                    return (
                      <tr key={m.id}>
                        <td className="mp-inv-sticky">
                          <span className="mp-inv-name block max-w-[14rem] truncate" title={m.ingredient.name}>{m.ingredient.name}</span>
                        </td>
                        <td className="text-op-muted tabular-nums">{formatDate(m.createdAt, { locale })}</td>
                        <td>
                          <span className="block max-w-[16rem] truncate" title={kindLabel(m)}>{kindLabel(m)}</span>
                          {/* Tarjeta angosta: sin columna de notas, la nota va debajo del tipo. */}
                          {note && <span className="@3xl:hidden block max-w-[16rem] truncate text-xs text-op-muted" title={note}>{note}</span>}
                        </td>
                        <td className={"text-right tabular-nums font-medium " + (isIn ? "text-ok" : "text-danger")}>{qtyText(m)}</td>
                        <td className="text-right tabular-nums text-op-muted">{valueText(m)}</td>
                        <td className="hidden @4xl:table-cell text-op-muted">
                          <span className="block max-w-[10rem] truncate">{m.createdBy?.name ?? "—"}</span>
                        </td>
                        <td className="hidden @3xl:table-cell text-op-muted mp-inv-greedy">
                          <span className="block truncate" title={note ?? undefined}>{note ?? "—"}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Celular: tarjetas de dos líneas. */}
            <ul className="md:hidden divide-y divide-op-border">
              {movements.map((m) => {
                const isIn = m.qtyBase >= 0;
                const note = noteText(m);
                return (
                  <li key={m.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="mp-inv-name truncate text-sm">{m.ingredient.name}</div>
                        <div className="mt-0.5 truncate text-xs text-op-muted">
                          {[formatDate(m.createdAt, { locale }), kindLabel(m), m.createdBy?.name ?? null].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={"text-sm font-medium tabular-nums " + (isIn ? "text-ok" : "text-danger")}>{qtyText(m)}</div>
                        <div className="mt-0.5 text-xs text-op-muted tabular-nums">{valueText(m)}</div>
                      </div>
                    </div>
                    {note && <div className="mt-1 text-xs text-op-muted">{note}</div>}
                  </li>
                );
              })}
            </ul>

            {nextCursor && (
              <div className="mp-pager">
                <span className="mp-pager__info">{t("movLoadedSome", { count: movements.length })}</span>
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
