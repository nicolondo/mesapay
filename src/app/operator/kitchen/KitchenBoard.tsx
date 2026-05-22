"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type KitchenStatus = "placed" | "in_kitchen" | "ready";
type CategoryKind = "starter" | "main" | "side" | "drink" | "dessert" | "other";

type Item = {
  id: string;
  qty: number;
  name: string;
  modifiers: string[];
  notes: string | null;
  guestName: string | null;
  kitchenStatus: KitchenStatus;
  categoryKind: CategoryKind;
  servedAt: string | null;
};

type Round = {
  id: string;
  seq: number;
  status: KitchenStatus;
  placedAt: string;
  readyAt: string | null;
  order: {
    id: string;
    shortCode: string;
    tableNumber: number;
    servingMode: "asReady" | "together";
    orderType: "dineIn" | "pickup";
    pickupName: string | null;
    etaMinutes: number | null;
    readyEta: string | null;
  };
  items: Item[];
};

const COLUMNS: { key: KitchenStatus; label: string; tint: string }[] = [
  { key: "placed", label: "Por preparar", tint: "border-[#C98A2E]/40" },
  { key: "in_kitchen", label: "En cocina", tint: "border-[#B8893B]/50" },
  { key: "ready", label: "Listo", tint: "border-[#2E6B4C]/40" },
];

const NEXT_STATUS: Record<KitchenStatus, KitchenStatus | null> = {
  placed: "in_kitchen",
  in_kitchen: "ready",
  ready: null,
};

export function KitchenBoard({
  tenantSlug,
  serviceMode,
  rounds,
}: {
  tenantSlug: string;
  serviceMode: "table" | "counter";
  rounds: Round[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [pendingServed, setPendingServed] = useState<Set<string>>(new Set());
  // Optimistic per-item kitchen moves so taps feel instant.
  const [pendingKitchen, setPendingKitchen] = useState<
    Map<string, KitchenStatus>
  >(new Map());
  // (roundId, colKey) -> whether the cancellation form is open for that
  // specific card. Cards can show in multiple columns (one per status) when
  // items have advanced unevenly, so the key includes the column to scope
  // the open state.
  const [cancellingKey, setCancellingKey] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    es.addEventListener("message", () => {
      startTx(() => {
        setPendingServed(new Set());
        setPendingKitchen(new Map());
        router.refresh();
      });
    });
    return () => es.close();
  }, [tenantSlug, router]);

  async function advanceItems(itemIds: string[], to: KitchenStatus) {
    if (itemIds.length === 0) return;
    setPendingKitchen((prev) => {
      const next = new Map(prev);
      for (const id of itemIds) next.set(id, to);
      return next;
    });
    // Safety net: if SSE never arrives we still clear the optimistic
    // state so the buttons don't stay disabled forever.
    setTimeout(() => {
      setPendingKitchen((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const id of itemIds) {
          if (next.get(id) === to) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);
    await Promise.all(
      itemIds.map((id) =>
        fetch(`/api/operator/order-items/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kitchenStatus: to }),
        }),
      ),
    );
    startTx(() => router.refresh());
  }

  async function toggleServed(itemId: string, served: boolean) {
    setPendingServed((prev) => {
      const next = new Set(prev);
      if (served) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
    await fetch(`/api/operator/order-items/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ served }),
    });
    startTx(() => router.refresh());
  }

  async function serveItems(items: Item[]) {
    const pending = items.filter(
      (i) => !i.servedAt && !pendingServed.has(i.id),
    );
    if (!pending.length) return;
    setPendingServed((prev) => {
      const next = new Set(prev);
      for (const i of pending) next.add(i.id);
      return next;
    });
    await Promise.all(
      pending.map((i) =>
        fetch(`/api/operator/order-items/${i.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ served: true }),
        }),
      ),
    );
    startTx(() => router.refresh());
  }

  function effectiveItemStatus(i: Item): KitchenStatus {
    return pendingKitchen.get(i.id) ?? i.kitchenStatus;
  }

  async function cancelRound(roundId: string, reason: string) {
    const res = await fetch(`/api/operator/rounds/${roundId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled", reason }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? "cancel_failed");
    }
    setCancellingKey(null);
    startTx(() => router.refresh());
  }

  // Compute, once per render, the leftmost column each round appears in.
  // The cancel control should show on that card only — duplicating it on
  // every column where the round has items would clutter the board and let
  // the operator open two cancel forms for the same pedido.
  const cancelColByRound = new Map<string, KitchenStatus>();
  for (const r of rounds) {
    for (const col of COLUMNS) {
      if (r.items.some((i) => effectiveItemStatus(i) === col.key)) {
        cancelColByRound.set(r.id, col.key);
        break;
      }
    }
  }

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 p-6">
      {COLUMNS.map((col) => {
        // Each round appears in every column where it has at least one item
        // in that column's state — so advancing a single item moves just
        // that item across columns instead of holding back the whole round.
        const rows = rounds
          .map((r) => ({
            round: r,
            colItems: r.items.filter(
              (i) => effectiveItemStatus(i) === col.key,
            ),
          }))
          .filter((x) => x.colItems.length > 0);
        return (
          <div
            key={col.key}
            className="bg-op-surface rounded-2xl border border-op-border flex flex-col min-h-[70vh]"
          >
            <div className="px-4 py-3 border-b border-op-border flex items-center justify-between">
              <div className="font-display text-lg">{col.label}</div>
              <div className="font-mono text-xs text-op-muted tabular">
                {rows.length.toString().padStart(2, "0")}
              </div>
            </div>
            <ul className="p-3 space-y-3 overflow-auto">
              {rows.map(({ round: r, colItems }) => {
                const isReadyCol = col.key === "ready";
                const isPlacedCol = col.key === "placed";
                const isKitchenCol = col.key === "in_kitchen";
                const mode = r.order.servingMode;
                // "Fuertes juntos": mains wait for every main to be ready.
                // Non-mains (starters, drinks, sides, desserts) go out
                // as ready. Rounds without any main item fall back to
                // plain as-ready behaviour.
                const mainItems = r.items.filter(
                  (i) => i.categoryKind === "main",
                );
                const fuertesJuntos =
                  mode === "together" && mainItems.length > 0;
                const mainsAllReady =
                  !fuertesJuntos ||
                  mainItems.every(
                    (i) => effectiveItemStatus(i) === "ready",
                  );
                const colUnserved = colItems.filter(
                  (i) => !i.servedAt && !pendingServed.has(i.id),
                );
                const colServeable = colUnserved.filter(
                  (i) =>
                    !(
                      fuertesJuntos &&
                      i.categoryKind === "main" &&
                      !mainsAllReady
                    ),
                );
                const itemIds = colItems.map((i) => i.id);
                const isPartial = colItems.length < r.items.length;
                return (
                  <li
                    key={r.id + "-" + col.key}
                    className={"rounded-xl border-2 bg-op-bg p-3 " + col.tint}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-mono text-[11px] tracking-wider text-op-muted uppercase truncate">
                        {r.order.orderType === "pickup"
                          ? `Pickup · ${r.order.pickupName ?? r.order.shortCode}`
                          : serviceMode === "counter"
                            ? `Orden ${r.order.shortCode} · R${r.seq}`
                            : `${r.order.shortCode} · Mesa ${r.order.tableNumber} · R${r.seq}`}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {r.order.orderType === "pickup" && (
                          <span className="font-mono text-[9px] tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
                            Recoger
                          </span>
                        )}
                        {fuertesJuntos && (
                          <span className="font-mono text-[9px] tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
                            Fuertes juntos
                          </span>
                        )}
                        {r.order.orderType === "pickup" && r.order.readyEta && !isReadyCol && (
                          <EtaBadge readyEta={r.order.readyEta} />
                        )}
                        {isReadyCol && r.readyAt ? (
                          <PassTimer readyAt={r.readyAt} />
                        ) : (
                          <AgeTimer placedAt={r.placedAt} />
                        )}
                      </div>
                    </div>

                    {isPartial && (
                      <div className="mt-1 font-mono text-[9px] tracking-wider uppercase text-op-muted">
                        {colItems.length} de {r.items.length}
                      </div>
                    )}

                    <ul className="mt-2 space-y-2">
                      {colItems.map((i) => {
                        const status = effectiveItemStatus(i);
                        const served =
                          !!i.servedAt || pendingServed.has(i.id);
                        const heldByMains =
                          fuertesJuntos &&
                          i.categoryKind === "main" &&
                          !mainsAllReady;
                        const canServe =
                          status === "ready" && !heldByMains;
                        const advancePending = pendingKitchen.has(i.id);
                        return (
                          <li key={i.id} className="text-sm">
                            <ItemRow
                              item={i}
                              status={status}
                              served={served}
                              canServe={canServe}
                              advancePending={advancePending}
                              onAdvance={() => {
                                if (advancePending) return;
                                const to = NEXT_STATUS[status];
                                if (to) advanceItems([i.id], to);
                              }}
                              onToggleServed={() =>
                                toggleServed(i.id, !served)
                              }
                            />
                          </li>
                        );
                      })}
                    </ul>

                    {colItems.length > 1 && (
                      <div className="mt-3 flex gap-2 flex-wrap">
                        {isPlacedCol && (
                          <button
                            onClick={() => advanceItems(itemIds, "in_kitchen")}
                            className="flex-1 min-w-[120px] h-8 rounded-lg bg-ink text-bone text-xs font-medium"
                          >
                            Empezar {colItems.length}
                          </button>
                        )}
                        {isKitchenCol && (
                          <button
                            onClick={() => advanceItems(itemIds, "ready")}
                            className="flex-1 min-w-[120px] h-8 rounded-lg bg-ok text-bone text-xs font-medium"
                          >
                            Marcar {colItems.length} listos
                          </button>
                        )}
                        {isReadyCol && colServeable.length > 1 && (
                          <button
                            onClick={() => serveItems(colServeable)}
                            className="flex-1 min-w-[120px] h-8 rounded-lg bg-ink text-bone text-xs font-medium"
                          >
                            Servir {colServeable.length}
                          </button>
                        )}
                      </div>
                    )}
                    {isReadyCol && (
                      <div className="mt-2 flex justify-end">
                        <button
                          onClick={() => advanceItems(itemIds, "in_kitchen")}
                          className="h-7 px-2 rounded-md border border-op-border text-[11px] text-op-muted"
                        >
                          Volver a cocina
                        </button>
                      </div>
                    )}
                    {cancelColByRound.get(r.id) === col.key && (
                      <CancelControl
                        cardKey={r.id + "-" + col.key}
                        open={cancellingKey === r.id + "-" + col.key}
                        onOpen={() =>
                          setCancellingKey(r.id + "-" + col.key)
                        }
                        onClose={() => setCancellingKey(null)}
                        onConfirm={(reason) => cancelRound(r.id, reason)}
                      />
                    )}
                  </li>
                );
              })}
              {rows.length === 0 && (
                <li className="text-sm text-op-muted px-2 py-4 text-center">
                  —
                </li>
              )}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ItemRow({
  item,
  status,
  served,
  canServe,
  advancePending,
  onAdvance,
  onToggleServed,
}: {
  item: Item;
  status: KitchenStatus;
  served: boolean;
  canServe: boolean;
  advancePending: boolean;
  onAdvance: () => void;
  onToggleServed: () => void;
}) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <AdvanceControl
        status={status}
        pending={advancePending}
        onAdvance={onAdvance}
      />
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-start justify-between gap-2">
          <div
            className={
              "flex-1 text-sm " + (served ? "line-through text-op-muted" : "")
            }
          >
            <span className="font-mono">{item.qty}×</span> {item.name}
            {item.modifiers.length > 0 && (
              <span className={served ? "text-op-muted/70" : "text-op-muted"}>
                {" "}· {item.modifiers.join(" · ")}
              </span>
            )}
          </div>
          {item.guestName && (
            <span className="shrink-0 font-mono text-[10px] tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
              {item.guestName}
            </span>
          )}
        </div>
        {item.notes && (
          <div
            className={
              "text-xs italic mt-0.5 " +
              (served ? "text-op-muted/80" : "text-terracotta")
            }
          >
            “{item.notes}”
          </div>
        )}
      </div>
      {canServe && (
        <ServeControl served={served} onToggle={onToggleServed} />
      )}
    </div>
  );
}

function AdvanceControl({
  status,
  pending,
  onAdvance,
}: {
  status: KitchenStatus;
  pending: boolean;
  onAdvance: () => void;
}) {
  // Action-oriented label so the cook reads what tapping will DO,
  // not the current state of the item.
  if (status === "placed") {
    return (
      <button
        type="button"
        onClick={onAdvance}
        disabled={pending}
        className="shrink-0 w-[88px] h-9 rounded-lg bg-ink text-bone text-[11px] font-medium uppercase tracking-wider inline-flex items-center justify-center gap-1 active:scale-95 transition-transform disabled:opacity-50"
        title="Empezar a cocinar"
      >
        <PlayIcon /> Empezar
      </button>
    );
  }
  if (status === "in_kitchen") {
    return (
      <button
        type="button"
        onClick={onAdvance}
        disabled={pending}
        className="shrink-0 w-[88px] h-9 rounded-lg bg-[#C98A2E]/15 border border-[#C98A2E]/55 text-[#7F5A1F] text-[11px] font-medium uppercase tracking-wider inline-flex items-center justify-center gap-1 active:scale-95 transition-transform hover:bg-[#C98A2E]/25 disabled:opacity-50"
        title="Marcar listo"
      >
        <CheckIcon /> Listo
      </button>
    );
  }
  // ready — no further advance; show a static pill so layout stays aligned.
  return (
    <span
      aria-label="Listo"
      className="shrink-0 w-[88px] h-9 rounded-lg bg-[#2E6B4C]/12 border border-[#2E6B4C]/40 text-[#1E5339] text-[11px] font-medium uppercase tracking-wider inline-flex items-center justify-center gap-1"
    >
      <CheckIcon /> Listo
    </span>
  );
}

function ServeControl({
  served,
  onToggle,
}: {
  served: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={served}
      className={
        "shrink-0 w-[88px] h-9 rounded-lg text-[11px] font-medium uppercase tracking-wider inline-flex items-center justify-center gap-1 active:scale-95 transition-transform border " +
        (served
          ? "bg-ok border-ok text-bone"
          : "bg-op-surface border-op-border text-op-text hover:border-ok hover:bg-ok/5")
      }
      title={served ? "Quitar servido" : "Marcar servido"}
    >
      {served ? <CheckIcon /> : <CircleIcon />}
      {served ? "Servido" : "Servir"}
    </button>
  );
}

function PlayIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
function CircleIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

function AgeTimer({ placedAt }: { placedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const mins = Math.floor((now - new Date(placedAt).getTime()) / 60000);
  const tint =
    mins >= 15 ? "text-danger" : mins >= 8 ? "text-[#C98A2E]" : "text-op-muted";
  return (
    <span className={"font-mono text-xs tabular " + tint}>
      {mins < 1 ? "<1m" : `${mins}m`}
    </span>
  );
}

function EtaBadge({ readyEta }: { readyEta: string }) {
  // Shows the customer-promised ETA so the cook can pace against it.
  // Red once we're past it — that's the signal to push the order.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const mins = Math.round((new Date(readyEta).getTime() - now) / 60000);
  const late = mins < 0;
  const tint = late
    ? "text-danger border-danger/40 bg-danger/10"
    : mins <= 3
      ? "text-[#C98A2E] border-[#C98A2E]/40 bg-[#C98A2E]/10"
      : "text-op-muted border-op-border bg-op-bg";
  return (
    <span
      className={
        "font-mono text-[9px] tracking-wider uppercase px-1.5 py-0.5 rounded border tabular " +
        tint
      }
    >
      {late ? `+${Math.abs(mins)}m` : `ETA ${mins}m`}
    </span>
  );
}

// Quick-pick motives. Tapping one cancels the round immediately with that
// exact text as the reason — no need to type. Easy to extend.
const CANCEL_PRESETS: string[] = ["No está disponible"];

function CancelControl({
  cardKey,
  open,
  onOpen,
  onClose,
  onConfirm,
}: {
  cardKey: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Auto-focus when the form opens so the cook can start typing the
  // motivo immediately — matches the spec ("que se ponga el cursor
  // automaticamente en el campo para escribir el motivo").
  useEffect(() => {
    if (open) {
      // setTimeout so the textarea actually exists in the DOM before we
      // try to focus it (the parent state flip + paint).
      const t = setTimeout(() => ref.current?.focus(), 0);
      return () => clearTimeout(t);
    } else {
      setReason("");
      setErr(null);
    }
  }, [open]);

  if (!open) {
    return (
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onOpen}
          className="h-7 px-2 rounded-md border border-danger/30 text-[11px] text-danger hover:bg-danger/5"
          title="Cancelar este pedido"
        >
          Cancelar
        </button>
      </div>
    );
  }

  const trimmed = reason.trim();
  const canSubmit = trimmed.length >= 3 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(trimmed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No pudimos cancelar.");
    } finally {
      setBusy(false);
    }
  }

  // One-tap cancel with a canned reason. We use the preset text verbatim
  // so the operator doesn't need to confirm twice.
  async function submitPreset(preset: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(preset);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "No pudimos cancelar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      // The cardKey is here mostly for future-proofing tooling — it makes
      // each cancellation block uniquely addressable in tests.
      data-card-key={cardKey}
      className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-2"
    >
      <div className="flex flex-wrap gap-1.5 mb-2">
        {CANCEL_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => submitPreset(p)}
            disabled={busy}
            className="h-7 px-2.5 rounded-full bg-danger/15 text-danger text-[11px] font-medium hover:bg-danger/25 disabled:opacity-50"
            title={`Cancelar con motivo: ${p}`}
          >
            {p}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="font-mono text-[9px] tracking-wider uppercase text-danger">
          O escribe otro motivo
        </span>
        <textarea
          ref={ref}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl + Enter to submit so the operator doesn't have to
            // reach for the mouse.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          rows={2}
          maxLength={240}
          placeholder="Ej. cliente cambió de opinión, ingrediente agotado…"
          className="mt-1 w-full text-sm px-2 py-1.5 rounded border border-danger/40 bg-op-surface focus:outline-none focus:border-danger"
        />
      </label>
      {err && <div className="mt-1 text-[11px] text-danger">{err}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="h-7 px-3 rounded-md text-[11px] text-op-muted hover:text-op-text disabled:opacity-50"
        >
          Volver
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="h-7 px-3 rounded-md text-[11px] font-medium bg-danger text-bone disabled:opacity-50"
        >
          {busy ? "Cancelando…" : "Confirmar cancelación"}
        </button>
      </div>
    </div>
  );
}

function PassTimer({ readyAt }: { readyAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const mins = Math.floor((now - new Date(readyAt).getTime()) / 60000);
  const tint =
    mins >= 5 ? "text-danger" : mins >= 2 ? "text-[#C98A2E]" : "text-ok";
  return (
    <span className={"font-mono text-xs tabular " + tint}>
      {mins < 1 ? "Listo ahora" : `Listo hace ${mins}m`}
    </span>
  );
}
