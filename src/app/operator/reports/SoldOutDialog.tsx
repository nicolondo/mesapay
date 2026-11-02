"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { Icon } from "@/components/ui/Icon";
import {
  daysSince,
  groupSoldOutByCategory,
  type SoldOutItem,
} from "@/lib/menuSoldOut";

/** A partir de cuántos platos pendientes «Todos disponibles» pide confirmar. */
const CONFIRM_ALL_FROM = 6;

type RowState = "idle" | "saving" | "done" | "error";

/**
 * «Platos agotados»: se abre al abrir el turno (y desde el recordatorio de
 * Cierre) con los platos que siguen con `available = false`, agrupados por
 * categoría. Cada fila vuelve a ofrecer su plato con el PATCH del editor de
 * carta; «Todos disponibles» recorre los pendientes uno por uno. Hoja
 * inferior en el celular, popup centrado en escritorio (.mp-sheet--md-center).
 */
export function SoldOutDialog({
  items,
  onAvailable,
  onClose,
}: {
  items: SoldOutItem[];
  /** Un plato ya quedó disponible (para que el padre lo saque de su lista). */
  onAvailable: (id: string) => void;
  /** Cierre con cuántos platos se volvieron a ofrecer en esta sesión. */
  onClose: (changed: number) => void;
}) {
  const t = useTranslations("opReports");
  // Foto de la lista al abrir: los platos ya marcados se quedan a la vista
  // como «Ya disponible» en vez de desaparecer de la hoja.
  const [snapshot] = useState(items);
  const groups = useMemo(() => groupSoldOutByCategory(snapshot), [snapshot]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [confirmAll, setConfirmAll] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [someFailed, setSomeFailed] = useState(false);

  const pending = snapshot.filter((i) => rows[i.id] !== "done");
  const doneCount = snapshot.length - pending.length;
  const busy =
    progress !== null || Object.values(rows).some((s) => s === "saving");

  async function makeAvailable(id: string): Promise<boolean> {
    setRows((p) => ({ ...p, [id]: "saving" }));
    try {
      const r = await fetch(`/api/operator/menu-items/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ available: true }),
      });
      if (!r.ok) throw new Error("patch failed");
      setRows((p) => ({ ...p, [id]: "done" }));
      onAvailable(id);
      return true;
    } catch {
      setRows((p) => ({ ...p, [id]: "error" }));
      return false;
    }
  }

  async function makeAllAvailable() {
    setConfirmAll(false);
    setSomeFailed(false);
    const ids = pending.filter((i) => rows[i.id] !== "saving").map((i) => i.id);
    setProgress({ done: 0, total: ids.length });
    let failed = 0;
    // Uno por uno: el PATCH bloquea el stock del comercio en su transacción,
    // y así cada fila muestra su propio resultado (y el error, si lo hubo).
    for (let n = 0; n < ids.length; n++) {
      if (!(await makeAvailable(ids[n]))) failed++;
      setProgress({ done: n + 1, total: ids.length });
    }
    setProgress(null);
    if (failed > 0) setSomeFailed(true);
  }

  function requestAll() {
    if (pending.length >= CONFIRM_ALL_FROM) setConfirmAll(true);
    else void makeAllAvailable();
  }

  // Mientras hay guardados en curso no se cierra (ni con Escape): el padre
  // necesita el conteo final para refrescar la pantalla.
  const close = () => {
    if (busy) return;
    onClose(doneCount);
  };

  return (
    <AppDialog
      label={t("soldOutTitle")}
      onClose={close}
      className="mp-sheet mp-sheet--md-center"
    >
      <div className="flex items-start justify-between gap-3 border-b border-op-border py-4 pl-5 pr-3">
        <div className="min-w-0">
          <h2 className="font-display text-xl">{t("soldOutTitle")}</h2>
          <p className="text-sm text-op-muted mt-1">{t("soldOutIntro")}</p>
        </div>
        <button
          type="button"
          onClick={close}
          disabled={busy}
          aria-label={t("soldOutClose")}
          className="mp-icon-button shrink-0"
        >
          <Icon name="close" />
        </button>
      </div>

      <div className="max-h-[55dvh] overflow-y-auto overscroll-contain px-5 py-3">
        {groups.map((g) => (
          <section key={g.categoryName} className="mb-3 last:mb-0">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-1">
              {g.categoryName}
            </div>
            <ul className="divide-y divide-op-border">
              {g.items.map((it) => (
                <Row
                  key={it.id}
                  item={it}
                  state={rows[it.id] ?? "idle"}
                  disabled={progress !== null}
                  onMakeAvailable={() => void makeAvailable(it.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="border-t border-op-border px-5 py-3">
        {someFailed && (
          <p role="alert" className="text-xs text-danger mb-2">
            {t("soldOutAllError")}
          </p>
        )}
        {confirmAll ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">
              {t("soldOutAllConfirm", { count: pending.length })}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmAll(false)}
                className="mp-btn mp-btn--ghost mp-btn--sm"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => void makeAllAvailable()}
                className="mp-btn mp-btn--ok mp-btn--sm"
              >
                {t("soldOutAllYes")}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            {pending.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={close}
                  disabled={busy}
                  className="mp-btn mp-btn--ghost mp-btn--sm"
                >
                  {t("soldOutLeave")}
                </button>
                <button
                  type="button"
                  onClick={requestAll}
                  disabled={busy}
                  className="mp-btn mp-btn--ok mp-btn--sm"
                >
                  {progress
                    ? t("soldOutAllBusy", { done: progress.done, total: progress.total })
                    : t("soldOutAll")}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={close}
                className="mp-btn mp-btn--primary mp-btn--sm"
              >
                {t("soldOutClose")}
              </button>
            )}
          </div>
        )}
      </div>
    </AppDialog>
  );
}

function Row({
  item,
  state,
  disabled,
  onMakeAvailable,
}: {
  item: SoldOutItem;
  state: RowState;
  disabled: boolean;
  onMakeAvailable: () => void;
}) {
  const t = useTranslations("opReports");
  return (
    <li className="py-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{item.name}</div>
        {state === "error" ? (
          <div role="alert" className="text-[11px] text-danger">
            {t("soldOutItemError")}
          </div>
        ) : (
          <div className="text-[11px] text-op-muted">
            {t("soldOutSince", { days: daysSince(item.soldOutSince) })}
          </div>
        )}
      </div>
      {state === "done" ? (
        <span className="text-[12px] font-medium text-ok shrink-0">
          {t("soldOutDone")}
        </span>
      ) : (
        <button
          type="button"
          onClick={onMakeAvailable}
          disabled={disabled || state === "saving"}
          className="mp-btn mp-btn--secondary mp-btn--sm shrink-0"
        >
          {state === "saving"
            ? t("busy")
            : state === "error"
              ? t("soldOutRetry")
              : t("soldOutMakeAvailable")}
        </button>
      )}
    </li>
  );
}
