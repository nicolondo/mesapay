"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Item = {
  id: string;
  qty: number;
  name: string;
  modifiers: string[];
  notes: string | null;
  guestName: string | null;
  servedAt: string | null;
};

type Round = {
  id: string;
  seq: number;
  status: "placed" | "in_kitchen" | "ready";
  placedAt: string;
  readyAt: string | null;
  order: { id: string; shortCode: string; tableNumber: number };
  items: Item[];
};

const COLUMNS: { key: Round["status"]; label: string; tint: string }[] = [
  { key: "placed", label: "Por preparar", tint: "border-[#C98A2E]/40" },
  { key: "in_kitchen", label: "En cocina", tint: "border-[#B8893B]/50" },
  { key: "ready", label: "Listo", tint: "border-[#2E6B4C]/40" },
];

export function KitchenBoard({
  tenantSlug,
  rounds,
}: {
  tenantSlug: string;
  rounds: Round[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  // Local "just served" ids so the UI reacts instantly while the refresh lands.
  const [pendingServed, setPendingServed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    es.addEventListener("message", () => {
      startTx(() => {
        setPendingServed(new Set());
        router.refresh();
      });
    });
    return () => es.close();
  }, [tenantSlug, router]);

  async function advance(roundId: string, to: Round["status"]) {
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

  return (
    <div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-4 p-6">
      {COLUMNS.map((col) => {
        const rows = rounds.filter((r) => r.status === col.key);
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
                const isReady = col.key === "ready";
                const itemsPending = r.items.filter(
                  (i) => !i.servedAt && !pendingServed.has(i.id),
                ).length;
                return (
                  <li
                    key={r.id}
                    className={"rounded-xl border-2 bg-op-bg p-3 " + col.tint}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-[11px] tracking-wider text-op-muted uppercase">
                        {r.order.shortCode} · Mesa {r.order.tableNumber} · R{r.seq}
                      </div>
                      {isReady && r.readyAt ? (
                        <PassTimer readyAt={r.readyAt} />
                      ) : (
                        <AgeTimer placedAt={r.placedAt} />
                      )}
                    </div>
                    <ul className="mt-2 space-y-1.5">
                      {r.items.map((i) => {
                        const served = !!i.servedAt || pendingServed.has(i.id);
                        const content = (
                          <>
                            <div className="flex items-start justify-between gap-2">
                              <div
                                className={
                                  "flex-1 " +
                                  (served ? "line-through text-op-muted" : "")
                                }
                              >
                                <span className="font-mono">{i.qty}×</span>{" "}
                                {i.name}
                                {i.modifiers.length > 0 && (
                                  <span
                                    className={
                                      served
                                        ? "text-op-muted/70"
                                        : "text-op-muted"
                                    }
                                  >
                                    {" "}· {i.modifiers.join(" · ")}
                                  </span>
                                )}
                              </div>
                              {i.guestName && (
                                <span className="shrink-0 font-mono text-[10px] tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
                                  {i.guestName}
                                </span>
                              )}
                            </div>
                            {i.notes && (
                              <div
                                className={
                                  "text-xs italic mt-0.5 " +
                                  (served ? "text-op-muted/80" : "text-terracotta")
                                }
                              >
                                “{i.notes}”
                              </div>
                            )}
                          </>
                        );
                        if (!isReady) {
                          return (
                            <li key={i.id} className="text-sm">
                              {content}
                            </li>
                          );
                        }
                        return (
                          <li key={i.id} className="text-sm">
                            <button
                              type="button"
                              onClick={() => toggleServed(i.id, !served)}
                              className="w-full text-left flex items-start gap-2 py-0.5 active:scale-[0.99] transition-transform"
                              aria-pressed={served}
                            >
                              <span
                                className={
                                  "mt-0.5 w-4 h-4 rounded border shrink-0 inline-flex items-center justify-center text-[10px] leading-none " +
                                  (served
                                    ? "bg-ok border-ok text-bone"
                                    : "bg-op-surface border-op-border text-transparent")
                                }
                                aria-hidden
                              >
                                ✓
                              </span>
                              <div className="flex-1 min-w-0">{content}</div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="mt-3 flex gap-2">
                      {col.key === "placed" && (
                        <button
                          onClick={() => advance(r.id, "in_kitchen")}
                          className="flex-1 h-8 rounded-lg bg-ink text-bone text-xs font-medium"
                        >
                          Empezar
                        </button>
                      )}
                      {col.key === "in_kitchen" && (
                        <button
                          onClick={() => advance(r.id, "ready")}
                          className="flex-1 h-8 rounded-lg bg-ok text-bone text-xs font-medium"
                        >
                          Marcar listo
                        </button>
                      )}
                      {col.key === "ready" && (
                        <>
                          {itemsPending > 0 && (
                            <button
                              onClick={() => serveAll(r)}
                              className="flex-1 h-8 rounded-lg bg-ink text-bone text-xs font-medium"
                            >
                              Servir todo
                            </button>
                          )}
                          <button
                            onClick={() => advance(r.id, "in_kitchen")}
                            className="h-8 px-3 rounded-lg border border-op-border text-xs"
                          >
                            Volver a cocina
                          </button>
                        </>
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
