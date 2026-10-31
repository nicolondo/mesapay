"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import type { ServeAllStation, ServeAllTargets } from "@/lib/kds/serveAll";

export type ServeAllOutcome =
  | { ok: true; served: number }
  | { ok: false; error: string | null };

/**
 * «Servir todo»: enlace chico en el encabezado del tablero de cocina / bar.
 * Sólo lo monta el tablero para la administración del comercio (ver
 * `canServeAll`) y sólo cuando hay algo pendiente.
 *
 * Al tocarlo se CONGELA la lista de lo pendiente en ese momento y se pide
 * confirmación con cuántos productos y de cuántas mesas / pedidos. Lo que
 * entre mientras la confirmación está abierta no se incluye: se manda
 * exactamente la lista congelada.
 */
export function ServeAllControl({
  station,
  serviceMode,
  subStation,
  targets,
  onServeAll,
}: {
  station: ServeAllStation;
  serviceMode: "table" | "counter";
  subStation: string | null;
  targets: ServeAllTargets;
  onServeAll: (itemIds: string[]) => Promise<ServeAllOutcome>;
}) {
  const tr = useTranslations("kitchen");
  const [snapshot, setSnapshot] = useState<ServeAllTargets | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  // El aviso de resultado se va solo; el de error dura un poco más.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.tone === "ok" ? 4000 : 7000);
    return () => clearTimeout(t);
  }, [notice]);

  const itemsLabel = (count: number) =>
    station === "bar"
      ? tr("serveAllItemsBar", { count })
      : tr("serveAllItemsKitchen", { count });

  async function confirm() {
    if (!snapshot || busy) return;
    const ids = snapshot.itemIds;
    setSnapshot(null);
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await onServeAll(ids);
      if (outcome.ok) {
        setNotice({
          tone: "ok",
          text:
            outcome.served > 0
              ? tr("serveAllDone", { items: itemsLabel(outcome.served) })
              : tr("serveAllNothing"),
        });
      } else {
        setNotice({
          tone: "error",
          text: outcome.error === "forbidden" ? tr("serveAllForbidden") : tr("serveAllError"),
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const hasTargets = targets.itemIds.length > 0;
  if (!hasTargets && !busy && !notice) return null;

  // En mesa se cuentan mesas; con pedidos para recoger o en mostrador, pedidos.
  const byTables = snapshot !== null && serviceMode === "table" && !snapshot.hasPickup;

  return (
    <>
      {(hasTargets || busy) && (
        <button
          type="button"
          onClick={() => setSnapshot(targets)}
          disabled={busy || !hasTargets}
          title={tr("serveAllHint")}
          className="h-9 px-1 text-xs text-op-muted underline underline-offset-4 decoration-op-border hover:text-op-text disabled:opacity-50 disabled:no-underline"
        >
          {busy ? tr("serveAllWorking") : tr("serveAll")}
        </button>
      )}
      {notice && (
        <span
          role={notice.tone === "error" ? "alert" : "status"}
          className={"text-xs " + (notice.tone === "error" ? "text-danger" : "text-ok")}
        >
          {notice.text}
        </span>
      )}

      {snapshot && (
        <AppDialog
          label={tr("serveAllTitle")}
          onClose={() => setSnapshot(null)}
          placement="center"
          className="rounded-2xl"
        >
          <div className="p-5 space-y-3">
            <h2 className="font-display text-lg">{tr("serveAllTitle")}</h2>
            <p className="text-sm text-op-text">
              {byTables
                ? tr("serveAllConfirmTables", {
                    items: itemsLabel(snapshot.itemIds.length),
                    tables: snapshot.tableCount,
                  })
                : tr("serveAllConfirmOrders", {
                    items: itemsLabel(snapshot.itemIds.length),
                    orders: snapshot.orderCount,
                  })}
            </p>
            <p className="text-xs text-op-muted">
              {subStation
                ? tr("serveAllHintSub", { sub: subStation })
                : tr("serveAllHint")}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                autoFocus
                onClick={() => setSnapshot(null)}
                className="h-9 px-3 rounded-lg text-xs text-op-muted hover:text-op-text"
              >
                {tr("cancelGoBack")}
              </button>
              <button
                type="button"
                onClick={confirm}
                className="h-9 px-4 rounded-lg bg-ok text-bone text-xs font-medium active:scale-95 transition-transform"
              >
                {tr("serveAllConfirm")}
              </button>
            </div>
          </div>
        </AppDialog>
      )}
    </>
  );
}
