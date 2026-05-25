"use client";

import { useEffect, useState } from "react";

type ItemDetail = {
  id: string;
  name: string;
  qty: number;
  priceCents: number;
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  preparationStartedAt: string | null;
  servedAt: string | null;
  expediteRequestedAt: string | null;
  guestName: string | null;
  notes: string | null;
};

type Round = {
  id: string;
  seq: number;
  // OrderStatus enum incluye más valores que estos pero solo
  // filtramos por "cancelled" para esconderlas; el resto fluyen.
  status: string;
  placedAt: string;
  items: ItemDetail[];
};

/**
 * Detalle de mesa visto por el mesero — sheet bottom-up con cada plato,
 * su estado actual ("Por preparar / Preparando / Listo / Servido") y el
 * tiempo en cocina si aplica. Botón "🔥 Apurar" por item en preparación
 * pinta un badge en el kitchen board.
 *
 * Se monta en cada tarjeta de mesa de /operator/tables (que el mesero
 * ve via re-export /mesero/mesas). La data se fetcheaba ya en el server
 * page pero estaba comprimida en counts; acá pedimos a un endpoint
 * lightweight que devuelve los items expandidos cuando el sheet abre.
 */
export function TableDetailSheet({
  orderId,
  shortCode,
  tableLabel,
  initialRounds,
}: {
  orderId: string;
  shortCode: string;
  tableLabel: string;
  initialRounds: Round[];
}) {
  const [open, setOpen] = useState(false);
  const [rounds, setRounds] = useState<Round[]>(initialRounds);
  const [pendingExpedite, setPendingExpedite] = useState<Set<string>>(
    new Set(),
  );
  // Item id pending cancel — abre el sub-sheet de motivo.
  const [cancelTarget, setCancelTarget] = useState<{
    itemId: string;
    name: string;
  } | null>(null);

  // Refresca el detalle cada 15s mientras está abierto — los estados
  // de cocina cambian y queremos que el mesero vea ETA actualizada
  // sin tener que cerrar/reabrir.
  useEffect(() => {
    if (!open) return;
    const tick = async () => {
      try {
        const r = await fetch(`/api/operator/orders/${orderId}/detail`);
        if (!r.ok) return;
        const j = (await r.json()) as { rounds: Round[] };
        setRounds(j.rounds);
      } catch {}
    };
    void tick();
    const h = setInterval(tick, 15_000);
    return () => clearInterval(h);
  }, [open, orderId]);

  async function cancelItem(itemId: string, reason: string) {
    const r = await fetch(`/api/operator/order-items/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cancel: { reason } }),
    });
    if (!r.ok) {
      alert("No pudimos cancelar el plato. Intenta de nuevo.");
      return;
    }
    // Quitar el item localmente para feedback inmediato. El poll
    // siguiente trae la verdad del server (subtotal recalculado).
    setRounds((prev) =>
      prev
        .map((rd) => ({
          ...rd,
          items: rd.items.filter((it) => it.id !== itemId),
        }))
        .filter((rd) => rd.items.length > 0),
    );
    setCancelTarget(null);
  }

  async function expedite(itemId: string) {
    setPendingExpedite((s) => new Set(s).add(itemId));
    try {
      const r = await fetch(`/api/operator/order-items/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expedite: true }),
      });
      if (r.ok) {
        // Optimistically marcar el item como expedited localmente.
        const stamp = new Date().toISOString();
        setRounds((prev) =>
          prev.map((rd) => ({
            ...rd,
            items: rd.items.map((it) =>
              it.id === itemId ? { ...it, expediteRequestedAt: stamp } : it,
            ),
          })),
        );
      }
    } finally {
      setPendingExpedite((s) => {
        const next = new Set(s);
        next.delete(itemId);
        return next;
      });
    }
  }

  // Aplanamos rondas pero conservamos el seq como header — útil para
  // mostrar "Ronda 2" cuando el cliente pidió segunda vuelta.
  const visibleRounds = rounds.filter((r) => r.status !== "cancelled");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 w-full text-xs text-op-muted hover:text-op-text underline-offset-2 hover:underline text-left"
      >
        Ver detalle del pedido →
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full md:max-w-lg bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
                  {tableLabel} · {shortCode}
                </div>
                <h2 className="font-display text-2xl mt-1">Estado del pedido</h2>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted text-sm shrink-0"
                aria-label="Cerrar"
              >
                ✕
              </button>
            </div>

            {visibleRounds.length === 0 && (
              <div className="text-sm text-op-muted">
                No hay platos activos.
              </div>
            )}

            {visibleRounds.map((round) => (
              <section key={round.id} className="space-y-2">
                {visibleRounds.length > 1 && (
                  <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
                    Ronda {round.seq}
                  </div>
                )}
                <ul className="space-y-2">
                  {round.items.map((it) => {
                    const elapsed = it.preparationStartedAt
                      ? minutesSince(it.preparationStartedAt)
                      : null;
                    const readyElapsed = it.servedAt
                      ? null
                      : it.kitchenStatus === "ready" && it.preparationStartedAt
                        ? minutesSince(it.preparationStartedAt)
                        : null;
                    const canExpedite =
                      !it.servedAt &&
                      it.kitchenStatus !== "ready" &&
                      !it.expediteRequestedAt;
                    return (
                      <li
                        key={it.id}
                        className="rounded-xl border border-hairline bg-op-surface p-3"
                      >
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono tabular text-muted shrink-0">
                            {it.qty}×
                          </span>
                          <span className="flex-1 text-sm font-medium">
                            {it.name}
                          </span>
                          <StatusPill
                            status={
                              it.servedAt
                                ? "served"
                                : (it.kitchenStatus as
                                    | "placed"
                                    | "in_kitchen"
                                    | "ready")
                            }
                          />
                        </div>
                        {(it.notes || it.guestName) && (
                          <div className="mt-1 text-xs text-op-muted flex gap-2 flex-wrap">
                            {it.guestName && (
                              <span className="font-mono tracking-wider uppercase text-[10px]">
                                {it.guestName}
                              </span>
                            )}
                            {it.notes && <span>“{it.notes}”</span>}
                          </div>
                        )}
                        <div className="mt-1.5 flex items-center justify-between gap-2">
                          {/* El estado vive solo en el pill de la
                              derecha (StatusPill arriba). Acá solo
                              mostramos el elapsed time cuando aporta
                              info — duplicar "Preparando" / "Por
                              preparar" gastaba espacio sin valor. */}
                          <div className="text-[11px] text-op-muted">
                            {!it.servedAt &&
                              it.kitchenStatus === "in_kitchen" &&
                              elapsed != null &&
                              elapsed > 0 && (
                                <span>hace {elapsed} min</span>
                              )}
                            {!it.servedAt &&
                              it.kitchenStatus === "ready" &&
                              readyElapsed != null &&
                              readyElapsed > 0 && (
                                <span>listo hace {readyElapsed} min</span>
                              )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {/* Cancelar — solo si el item está en
                                "placed" (todavía no entró a cocina).
                                Una vez que cocina lo empieza, la
                                cancelación tiene que pasar por la
                                cocina (rinde cuenta de insumos /
                                tiempo) — no desde la app del mesero.
                                Ready / servido tampoco se cancelan
                                desde acá. */}
                            {!it.servedAt && it.kitchenStatus === "placed" && (
                              <button
                                type="button"
                                onClick={() =>
                                  setCancelTarget({
                                    itemId: it.id,
                                    name: it.name,
                                  })
                                }
                                className="font-mono text-[10px] tracking-wider uppercase text-danger hover:bg-danger/10 px-2 py-1 rounded-full"
                              >
                                Cancelar
                              </button>
                            )}
                            {it.expediteRequestedAt ? (
                              <span className="font-mono text-[10px] tracking-wider uppercase text-terracotta bg-terracotta/15 px-2 py-0.5 rounded-full">
                                🔥 Apurado
                              </span>
                            ) : canExpedite ? (
                              <button
                                type="button"
                                onClick={() => expedite(it.id)}
                                disabled={pendingExpedite.has(it.id)}
                                className="font-mono text-[10px] tracking-wider uppercase border border-terracotta/40 text-terracotta hover:bg-terracotta/10 px-2 py-1 rounded-full disabled:opacity-40"
                              >
                                {pendingExpedite.has(it.id)
                                  ? "Avisando…"
                                  : "🔥 Apurar"}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            <p className="text-[10px] text-op-muted">
              El detalle se actualiza automáticamente cada 15 segundos.
            </p>
          </div>
        </div>
      )}

      {cancelTarget && (
        <CancelItemSheet
          itemName={cancelTarget.name}
          onClose={() => setCancelTarget(null)}
          onConfirm={(reason) => cancelItem(cancelTarget.itemId, reason)}
        />
      )}
    </>
  );
}

const CANCEL_PRESETS = [
  "Cliente cambió de opinión",
  "Demora excesiva",
  "Error al tomar pedido",
  "Ingrediente faltante",
];

function CancelItemSheet({
  itemName,
  onClose,
  onConfirm,
}: {
  itemName: string;
  onClose: () => void;
  onConfirm: (reason: string) => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= 3 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onConfirm(trimmed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-ink/50 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
              Cancelar plato
            </div>
            <h2 className="font-display text-2xl mt-1">{itemName}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <p className="text-xs text-muted">
          Sale del pedido, del kitchen board y del subtotal. Esta acción
          no se puede deshacer — si era un error, tendrá que volver a
          pedirse.
        </p>

        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            Motivo
          </div>
          <div className="flex flex-wrap gap-2 mb-2">
            {CANCEL_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setReason(p)}
                className={
                  "h-8 px-3 rounded-full text-[11px] font-medium border transition-colors " +
                  (reason === p
                    ? "bg-ink text-bone border-ink"
                    : "bg-paper border-hairline text-ink hover:border-ink")
                }
              >
                {p}
              </button>
            ))}
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="O escribe otro motivo…"
            rows={2}
            className="w-full px-3 py-2 rounded-lg border border-hairline bg-paper text-sm resize-none"
          />
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="w-full h-12 rounded-2xl bg-danger text-bone text-base font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? "Cancelando…" : "Cancelar plato"}
        </button>
      </div>
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: "placed" | "in_kitchen" | "ready" | "served";
}) {
  const map: Record<typeof status, { label: string; cls: string }> = {
    placed: { label: "Por preparar", cls: "bg-op-bg text-op-muted" },
    in_kitchen: { label: "Preparando", cls: "bg-[#C98A2E]/15 text-[#8F6828]" },
    ready: { label: "Listo", cls: "bg-ok/15 text-ok" },
    served: { label: "Servido", cls: "bg-op-bg text-op-muted" },
  };
  const m = map[status];
  return (
    <span
      className={
        "shrink-0 font-mono text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-full " +
        m.cls
      }
    >
      {m.label}
    </span>
  );
}

function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}
