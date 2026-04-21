"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type KitchenStatus = "placed" | "in_kitchen" | "ready";

type Item = {
  id: string;
  qty: number;
  name: string;
  modifiers: string[];
  notes: string | null;
  guestName: string | null;
  kitchenStatus: KitchenStatus;
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

const STATUS_LABEL: Record<KitchenStatus, string> = {
  placed: "Pendiente",
  in_kitchen: "Cocinando",
  ready: "Listo",
};

export function KitchenBoard({
  tenantSlug,
  rounds,
}: {
  tenantSlug: string;
  rounds: Round[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [pendingServed, setPendingServed] = useState<Set<string>>(new Set());
  // Optimistic per-item kitchen moves so taps feel instant.
  const [pendingKitchen, setPendingKitchen] = useState<
    Map<string, KitchenStatus>
  >(new Map());

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

  async function advanceItem(itemId: string, to: KitchenStatus) {
    setPendingKitchen((prev) => {
      const next = new Map(prev);
      next.set(itemId, to);
      return next;
    });
    await fetch(`/api/operator/order-items/${itemId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kitchenStatus: to }),
    });
    startTx(() => router.refresh());
  }

  async function advanceRound(roundId: string, to: KitchenStatus) {
    // Bulk path: also optimistically mark every item in the round.
    const round = rounds.find((r) => r.id === roundId);
    if (round) {
      setPendingKitchen((prev) => {
        const next = new Map(prev);
        for (const it of round.items) next.set(it.id, to);
        return next;
      });
    }
    await fetch(`/api/operator/rounds/${roundId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: to }),
    });
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

  async function serveAll(round: Round) {
    const pending = round.items.filter(
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

  function roundColumn(r: Round): KitchenStatus {
    // Weakest-link: round shows in the column of its least-advanced item.
    const statuses = r.items.map(effectiveItemStatus);
    if (statuses.some((s) => s === "placed")) return "placed";
    if (statuses.some((s) => s === "in_kitchen")) return "in_kitchen";
    return "ready";
  }

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 p-6">
      {COLUMNS.map((col) => {
        const rows = rounds.filter((r) => roundColumn(r) === col.key);
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
              {rows.map((r) => {
                const isReadyCol = col.key === "ready";
                const mode = r.order.servingMode;
                const itemsPending = r.items.filter(
                  (i) => !i.servedAt && !pendingServed.has(i.id),
                ).length;
                const itemsReady = r.items.filter(
                  (i) => effectiveItemStatus(i) === "ready",
                );
                const itemsPlaced = r.items.filter(
                  (i) => effectiveItemStatus(i) === "placed",
                );
                const itemsCooking = r.items.filter(
                  (i) => effectiveItemStatus(i) === "in_kitchen",
                );
                return (
                  <li
                    key={r.id}
                    className={"rounded-xl border-2 bg-op-bg p-3 " + col.tint}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-mono text-[11px] tracking-wider text-op-muted uppercase truncate">
                        {r.order.shortCode} · Mesa {r.order.tableNumber} · R{r.seq}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {mode === "together" && (
                          <span className="font-mono text-[9px] tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
                            Servir junto
                          </span>
                        )}
                        {isReadyCol && r.readyAt ? (
                          <PassTimer readyAt={r.readyAt} />
                        ) : (
                          <AgeTimer placedAt={r.placedAt} />
                        )}
                      </div>
                    </div>

                    <ul className="mt-2 space-y-1.5">
                      {r.items.map((i) => {
                        const status = effectiveItemStatus(i);
                        const served = !!i.servedAt || pendingServed.has(i.id);
                        const canServe =
                          status === "ready" &&
                          (mode === "asReady" || itemsReady.length === r.items.length);
                        return (
                          <li key={i.id} className="text-sm">
                            <ItemRow
                              item={i}
                              status={status}
                              served={served}
                              canServe={canServe}
                              onAdvance={() => {
                                const to = NEXT_STATUS[status];
                                if (to) advanceItem(i.id, to);
                              }}
                              onToggleServed={() =>
                                toggleServed(i.id, !served)
                              }
                            />
                          </li>
                        );
                      })}
                    </ul>

                    <div className="mt-3 flex gap-2 flex-wrap">
                      {itemsPlaced.length > 0 && (
                        <button
                          onClick={() => advanceRound(r.id, "in_kitchen")}
                          className="flex-1 min-w-[120px] h-8 rounded-lg bg-ink text-bone text-xs font-medium"
                        >
                          Empezar todo
                        </button>
                      )}
                      {itemsCooking.length > 0 && itemsPlaced.length === 0 && (
                        <button
                          onClick={() => advanceRound(r.id, "ready")}
                          className="flex-1 min-w-[120px] h-8 rounded-lg bg-ok text-bone text-xs font-medium"
                        >
                          Marcar todo listo
                        </button>
                      )}
                      {isReadyCol && itemsPending > 0 && (
                        <button
                          onClick={() => serveAll(r)}
                          className="flex-1 min-w-[120px] h-8 rounded-lg bg-ink text-bone text-xs font-medium"
                        >
                          Servir todo
                        </button>
                      )}
                      {isReadyCol && (
                        <button
                          onClick={() => advanceRound(r.id, "in_kitchen")}
                          className="h-8 px-3 rounded-lg border border-op-border text-xs"
                        >
                          Volver a cocina
                        </button>
                      )}
                    </div>
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
  onAdvance,
  onToggleServed,
}: {
  item: Item;
  status: KitchenStatus;
  served: boolean;
  canServe: boolean;
  onAdvance: () => void;
  onToggleServed: () => void;
}) {
  const statusTint: Record<KitchenStatus, string> = {
    placed: "bg-op-bg border-op-border text-op-muted",
    in_kitchen: "bg-[#C98A2E]/12 border-[#C98A2E]/40 text-[#8F6828]",
    ready: "bg-[#2E6B4C]/12 border-[#2E6B4C]/40 text-[#1E5339]",
  };

  const body = (
    <div className="flex items-start justify-between gap-2">
      <div className={"flex-1 " + (served ? "line-through text-op-muted" : "")}>
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
  );

  const notes = item.notes && (
    <div
      className={
        "text-xs italic mt-0.5 " +
        (served ? "text-op-muted/80" : "text-terracotta")
      }
    >
      “{item.notes}”
    </div>
  );

  return (
    <div className="flex items-start gap-2 py-0.5">
      {canServe ? (
        <button
          type="button"
          onClick={onToggleServed}
          aria-pressed={served}
          className="mt-0.5 shrink-0 inline-flex items-center justify-center active:scale-95 transition-transform"
          title={served ? "Marcar como no servido" : "Marcar como servido"}
        >
          <span
            className={
              "w-4 h-4 rounded border inline-flex items-center justify-center text-[10px] leading-none " +
              (served
                ? "bg-ok border-ok text-bone"
                : "bg-op-surface border-op-border text-transparent")
            }
            aria-hidden
          >
            ✓
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={onAdvance}
          disabled={status === "ready"}
          className={
            "mt-0.5 shrink-0 inline-flex items-center h-5 px-1.5 rounded border text-[9px] uppercase tracking-wider font-medium active:scale-95 transition-transform disabled:opacity-100 disabled:cursor-default " +
            statusTint[status]
          }
          title={
            status === "placed"
              ? "Empezar a cocinar"
              : status === "in_kitchen"
                ? "Marcar listo"
                : "Esperando"
          }
        >
          {STATUS_LABEL[status]}
        </button>
      )}
      <div className="flex-1 min-w-0">
        {body}
        {notes}
      </div>
    </div>
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
