"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

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
type FreeTable = {
  id: string;
  number: number;
  label: string | null;
};

export function TableDetailSheet({
  orderId,
  shortCode,
  tableLabel,
  tableNumber,
  tableId,
  initialRounds,
  freeTables,
  open: externalOpen,
  onOpenChange,
  hideTrigger,
  orderStatus,
  outstandingCents,
  subtotalCents,
  tenantSlug,
  qrToken,
  isMeseroView,
}: {
  orderId: string;
  shortCode: string;
  tableLabel: string;
  tableNumber: number;
  // Mesa donde vive la orden — sirve para el botón "Agregar platos"
  // en modo mesero (ruta interna /mesero/pedir/[id]).
  tableId: string;
  initialRounds: Round[];
  // Mesas libres del restaurante (sin orden abierta) para el sheet
  // de "Mover a otra mesa". Server pre-llena. Si no hay ninguna
  // (todas ocupadas) se esconde el botón.
  freeTables: FreeTable[];
  // Modo controlled: si el padre pasa `open` + `onOpenChange`, el
  // sheet sigue el estado externo. Útil para que la grilla compacta
  // de Mesas dispare el sheet al tap del tile. Si no se pasan,
  // funciona como antes (renderea su propio botón trigger).
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  // Opcional: cuando el padre maneja el trigger por afuera (ej:
  // tap en el tile), pasamos `hideTrigger` para esconder el link
  // interno "Ver detalle del pedido →".
  hideTrigger?: boolean;
  // Estado de la orden + monto pendiente. Necesarios para mostrar
  // el botón "Cobrar la cuenta" (sólo si outstanding > 0) y para el
  // botón "Cancelar" (sólo si placed/in_kitchen). Cuando no se
  // pasan (back-compat con triggers viejos), el sheet no muestra
  // estas acciones.
  orderStatus?: string;
  outstandingCents?: number;
  subtotalCents?: number;
  // Para el botón "Cobrar la cuenta" + el link de agregar platos
  // en modo operator/admin (abre tab nueva del menú público).
  tenantSlug?: string;
  qrToken?: string;
  isMeseroView?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = externalOpen !== undefined;
  const open = controlled ? externalOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (controlled) onOpenChange?.(next);
    else setInternalOpen(next);
  };
  const [rounds, setRounds] = useState<Round[]>(initialRounds);
  const [pendingExpedite, setPendingExpedite] = useState<Set<string>>(
    new Set(),
  );
  // Item id pending cancel — abre el sub-sheet de motivo.
  const [cancelTarget, setCancelTarget] = useState<{
    itemId: string;
    name: string;
  } | null>(null);
  const [showMoveSheet, setShowMoveSheet] = useState(false);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  // Cancelar la orden completa — sólo aplica cuando la cocina no
  // ha plateado nada (status placed/in_kitchen). Una vez cancelada
  // cerramos el sheet y refrescamos.
  const [cancelOrderBusy, setCancelOrderBusy] = useState(false);
  const router = useRouter();
  const [, startTx] = useTransition();

  async function cancelOrder() {
    if (!window.confirm("¿Cancelar esta orden? No se podrá revertir.")) return;
    setCancelOrderBusy(true);
    const res = await fetch(`/api/operator/orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled" }),
    });
    setCancelOrderBusy(false);
    if (!res.ok) {
      window.alert("No se pudo cancelar la orden.");
      return;
    }
    setOpen(false);
    startTx(() => router.refresh());
  }

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

  async function moveOrderToTable(targetTableId: string) {
    setMoveErr(null);
    const r = await fetch(`/api/operator/orders/${orderId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetTableId }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMoveErr(j.message ?? j.error ?? "No pudimos mover la cuenta");
      return;
    }
    // El SSE de order.updated va a refrescar ambas tarjetas. Cerramos
    // todo lo abierto y dejamos que la grid se redibuje.
    setShowMoveSheet(false);
    setOpen(false);
  }

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
      {!hideTrigger && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 w-full text-xs text-op-muted hover:text-op-text underline-offset-2 hover:underline text-left"
        >
          Ver detalle del pedido →
        </button>
      )}

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

            {/* Resumen del cobro + acciones principales. "Agregar
                platos" siempre visible (acción frecuente); "Cobrar
                la cuenta" sólo si queda algo por cobrar; "Cancelar"
                sólo si la cocina no ha plateado. */}
            {(subtotalCents != null || outstandingCents != null) && (
              <div className="rounded-xl border border-hairline bg-op-bg p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                    {outstandingCents && outstandingCents > 0
                      ? "Pendiente"
                      : "Cuenta total"}
                  </div>
                  <div className="font-display text-2xl tabular leading-tight">
                    {fmtCOP(
                      outstandingCents != null
                        ? outstandingCents
                        : subtotalCents ?? 0,
                    )}
                  </div>
                  {outstandingCents != null &&
                    outstandingCents > 0 &&
                    subtotalCents != null &&
                    subtotalCents !== outstandingCents && (
                      <div className="font-mono text-[10px] text-op-muted mt-0.5">
                        de {fmtCOP(subtotalCents)}
                      </div>
                    )}
                </div>
              </div>
            )}

            {/* Acciones: todas full-width, h-11, rounded-full. Ritmo
                visual uniforme. Ink para la primaria (Agregar),
                terracotta para Cobrar (acción de plata, distinta
                de la primaria), outline para Mover, outline-danger
                para Cancelar. Sólo se muestran cuando hace sentido:
                  - Agregar: siempre que podamos armar la URL
                  - Cobrar: outstanding > 0 + orden no paga/cancelada
                  - Mover: hay mesas libres a donde mover
                  - Cancelar: cocina todavía no plateó (placed/in_kitchen) */}
            {(() => {
              const canCharge =
                outstandingCents != null &&
                outstandingCents > 0 &&
                orderStatus !== "paid" &&
                orderStatus !== "cancelled" &&
                !!tenantSlug;
              const canCancelOrder =
                orderStatus === "placed" || orderStatus === "in_kitchen";
              const canAdd =
                isMeseroView || (tenantSlug && qrToken);
              const canMove = freeTables.length > 0;
              if (!canAdd && !canCharge && !canMove && !canCancelOrder)
                return null;
              return (
                <div className="space-y-2">
                  {canAdd && (
                    <Link
                      href={
                        isMeseroView
                          ? `/mesero/pedir/${tableId}`
                          : `/t/${tenantSlug}/menu?table=${qrToken}&op=1`
                      }
                      {...(isMeseroView
                        ? {}
                        : { target: "_blank", rel: "noreferrer" })}
                      className="w-full h-11 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center justify-center gap-1.5 hover:bg-ink/90"
                    >
                      <span aria-hidden className="text-base leading-none">+</span>
                      <span>Agregar platos</span>
                    </Link>
                  )}
                  {canCharge && (
                    <a
                      href={`/t/${tenantSlug}/pay/${orderId}?op=1`}
                      target="_blank"
                      rel="noreferrer"
                      className="w-full h-11 rounded-full bg-terracotta text-bone text-sm font-medium inline-flex items-center justify-center hover:brightness-95"
                    >
                      Cobrar la cuenta
                    </a>
                  )}
                  {canMove && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoveErr(null);
                        setShowMoveSheet(true);
                      }}
                      className="w-full h-11 rounded-full border border-hairline bg-paper text-ink text-sm font-medium hover:bg-op-bg"
                    >
                      Mover a otra mesa
                    </button>
                  )}
                  {canCancelOrder && (
                    <button
                      type="button"
                      onClick={cancelOrder}
                      disabled={cancelOrderBusy}
                      className="w-full h-11 rounded-full border border-danger/40 text-danger text-sm font-medium hover:bg-danger/5 disabled:opacity-60"
                    >
                      {cancelOrderBusy
                        ? "Cancelando…"
                        : "Cancelar la cuenta"}
                    </button>
                  )}
                </div>
              );
            })()}

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

      {showMoveSheet && (
        <MoveTableSheet
          sourceTableNumber={tableNumber}
          freeTables={freeTables}
          err={moveErr}
          onClose={() => setShowMoveSheet(false)}
          onPick={(tid) => moveOrderToTable(tid)}
        />
      )}
    </>
  );
}

function MoveTableSheet({
  sourceTableNumber,
  freeTables,
  err,
  onClose,
  onPick,
}: {
  sourceTableNumber: number;
  freeTables: FreeTable[];
  err: string | null;
  onClose: () => void;
  onPick: (targetTableId: string) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  async function pick(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await onPick(id);
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
              Mover de Mesa {sourceTableNumber}
            </div>
            <h2 className="font-display text-2xl mt-1">Elige mesa destino</h2>
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
          Solo se listan mesas libres. Si la mesa destino tiene cuenta
          abierta, ciérrala antes de mover.
        </p>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-2">
          {freeTables.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pick(t.id)}
              disabled={busy}
              className="h-14 rounded-xl bg-op-surface border border-hairline hover:border-ink/40 disabled:opacity-50 flex flex-col items-center justify-center"
              title={t.label ?? undefined}
            >
              <div className="font-display text-lg tabular leading-none">
                {t.number}
              </div>
              {t.label && (
                <div className="text-[10px] text-op-muted mt-0.5 truncate max-w-full px-1">
                  {t.label}
                </div>
              )}
            </button>
          ))}
        </div>

        {err && <div className="text-xs text-danger">{err}</div>}
      </div>
    </div>
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
