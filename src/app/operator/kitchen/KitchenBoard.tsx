"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Round = {
  id: string;
  seq: number;
  status: "placed" | "in_kitchen" | "ready";
  placedAt: string;
  order: { id: string; shortCode: string; tableNumber: number };
  items: { id: string; qty: number; name: string; modifiers: string[]; notes: string | null }[];
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

  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    es.addEventListener("message", () => {
      startTx(() => router.refresh());
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
              {rows.map((r) => (
                <li
                  key={r.id}
                  className={"rounded-xl border-2 bg-op-bg p-3 " + col.tint}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-[11px] tracking-wider text-op-muted uppercase">
                      {r.order.shortCode} · Mesa {r.order.tableNumber} · R{r.seq}
                    </div>
                    <AgeTimer placedAt={r.placedAt} />
                  </div>
                  <ul className="mt-2 space-y-1">
                    {r.items.map((i) => (
                      <li key={i.id} className="text-sm">
                        <span className="font-mono">{i.qty}×</span> {i.name}
                        {i.modifiers.length > 0 && (
                          <span className="text-op-muted">
                            {" "}
                            · {i.modifiers.join(" · ")}
                          </span>
                        )}
                        {i.notes && (
                          <div className="text-xs text-terracotta italic">
                            “{i.notes}”
                          </div>
                        )}
                      </li>
                    ))}
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
                      <button
                        onClick={() => advance(r.id, "in_kitchen")}
                        className="h-8 px-3 rounded-lg border border-op-border text-xs"
                      >
                        Volver a cocina
                      </button>
                    )}
                  </div>
                </li>
              ))}
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
