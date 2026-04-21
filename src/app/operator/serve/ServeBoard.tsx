"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type CategoryKind = "starter" | "main" | "side" | "drink" | "dessert" | "other";

type Item = {
  id: string;
  qty: number;
  name: string;
  modifiers: string[];
  notes: string | null;
  guestName: string | null;
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  categoryKind: CategoryKind;
  servedAt: string | null;
};

type Round = {
  id: string;
  seq: number;
  readyAt: string | null;
  order: {
    id: string;
    shortCode: string;
    tableNumber: number;
    servingMode: "asReady" | "together";
  };
  items: Item[];
};

export function ServeBoard({
  tenantSlug,
  rounds,
}: {
  tenantSlug: string;
  rounds: Round[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [pendingServed, setPendingServed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    es.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "order.ready") {
          try {
            navigator.vibrate?.([120, 60, 120]);
          } catch {}
        }
      } catch {}
      startTx(() => {
        setPendingServed(new Set());
        router.refresh();
      });
    });
    return () => es.close();
  }, [tenantSlug, router]);

  async function serveItem(id: string) {
    setPendingServed((p) => new Set(p).add(id));
    await fetch(`/api/operator/order-items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ served: true }),
    });
    startTx(() => router.refresh());
  }

  async function serveItems(items: Item[]) {
    const pending = items.filter(
      (i) => !i.servedAt && !pendingServed.has(i.id),
    );
    if (!pending.length) return;
    setPendingServed((p) => {
      const next = new Set(p);
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

  const byTable = new Map<number, Round[]>();
  for (const r of rounds) {
    const arr = byTable.get(r.order.tableNumber) ?? [];
    arr.push(r);
    byTable.set(r.order.tableNumber, arr);
  }
  const tables = Array.from(byTable.entries()).sort((a, b) => a[0] - b[0]);

  const totalReady = rounds.reduce(
    (s, r) =>
      s +
      r.items.filter(
        (i) =>
          i.kitchenStatus === "ready" &&
          !i.servedAt &&
          !pendingServed.has(i.id),
      ).length,
    0,
  );

  if (tables.length === 0) {
    return (
      <div className="p-10 text-center">
        <div className="font-display text-3xl mb-1">Todo entregado</div>
        <div className="text-sm text-op-muted">
          Cuando la cocina marque algo como listo, aparecerá aquí.
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto w-full">
      <div className="flex items-baseline justify-between mb-4">
        <div className="font-display text-3xl">Salón</div>
        <div className="font-mono text-xs text-op-muted">
          {totalReady} {totalReady === 1 ? "plato listo" : "platos listos"} ·{" "}
          {tables.length} {tables.length === 1 ? "mesa" : "mesas"}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {tables.map(([num, trounds]) => (
          <div
            key={num}
            className="border border-op-border rounded-2xl bg-op-surface flex flex-col"
          >
            <div className="px-4 py-3 border-b border-op-border flex items-center justify-between">
              <div className="font-display text-2xl">Mesa {num}</div>
              <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
                {trounds.length} {trounds.length === 1 ? "ronda" : "rondas"}
              </div>
            </div>
            <ul className="p-3 space-y-3">
              {trounds.map((r) => (
                <RoundCard
                  key={r.id}
                  round={r}
                  pendingServed={pendingServed}
                  onServeItem={serveItem}
                  onServeItems={serveItems}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoundCard({
  round: r,
  pendingServed,
  onServeItem,
  onServeItems,
}: {
  round: Round;
  pendingServed: Set<string>;
  onServeItem: (id: string) => void;
  onServeItems: (items: Item[]) => void;
}) {
  const mode = r.order.servingMode;

  // "Fuertes juntos": mains wait for every main to be ready; everything
  // else still goes out as soon as it's done. Rounds with no mains fall
  // back to plain as-ready.
  const mainItems = r.items.filter((i) => i.categoryKind === "main");
  const fuertesJuntos = mode === "together" && mainItems.length > 0;
  const mainsAllReady =
    !fuertesJuntos || mainItems.every((i) => i.kitchenStatus === "ready");
  const mainsCooking = mainItems.filter(
    (i) => i.kitchenStatus !== "ready",
  ).length;

  // Ready-unserved items that we render as individual "entregar" cards:
  //  - always: non-mains in fuertesJuntos mode
  //  - always: everything in asReady mode (mains included)
  const loose = r.items.filter((i) => {
    if (i.kitchenStatus !== "ready") return false;
    if (i.servedAt || pendingServed.has(i.id)) return false;
    if (fuertesJuntos && i.categoryKind === "main") return false;
    return true;
  });

  // Mains ready but still waiting on other mains → show a waiting card
  const mainsUnserved = mainItems.filter(
    (i) => !i.servedAt && !pendingServed.has(i.id),
  );
  const mainsReadyUnserved = mainsUnserved.filter(
    (i) => i.kitchenStatus === "ready",
  );

  return (
    <>
      {loose.map((i) => (
        <SingleServeCard
          key={i.id}
          item={i}
          round={r}
          onServe={() => onServeItem(i.id)}
        />
      ))}

      {fuertesJuntos && !mainsAllReady && mainsReadyUnserved.length > 0 && (
        <MainsWaitingCard round={r} cookingCount={mainsCooking} />
      )}

      {fuertesJuntos && mainsAllReady && mainsUnserved.length > 0 && (
        <MainsBulkCard
          round={r}
          items={mainsUnserved}
          onServe={() => onServeItems(mainsUnserved)}
        />
      )}
    </>
  );
}

function SingleServeCard({
  item: i,
  round: r,
  onServe,
}: {
  item: Item;
  round: Round;
  onServe: () => void;
}) {
  return (
    <li className="rounded-xl border-2 border-[#2E6B4C]/50 bg-[#2E6B4C]/5 p-3">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted truncate">
          {r.order.shortCode} · R{r.seq}
        </div>
        {r.readyAt && <PassTimer readyAt={r.readyAt} />}
      </div>
      <div className="mt-2 flex items-start gap-2">
        <div className="flex-1">
          <div className="text-sm">
            <span className="font-mono">{i.qty}×</span> {i.name}
          </div>
          {i.modifiers.length > 0 && (
            <div className="text-xs text-op-muted mt-0.5">
              {i.modifiers.join(" · ")}
            </div>
          )}
          {i.notes && (
            <div className="text-xs italic text-terracotta mt-0.5">
              “{i.notes}”
            </div>
          )}
        </div>
        {i.guestName && (
          <span className="shrink-0 font-mono text-[10px] tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
            {i.guestName}
          </span>
        )}
      </div>
      <button
        onClick={onServe}
        className="mt-3 w-full h-11 rounded-xl bg-ok text-bone text-sm font-medium active:scale-[0.98] transition-transform"
      >
        Entregado
      </button>
    </li>
  );
}

function MainsWaitingCard({
  round: r,
  cookingCount,
}: {
  round: Round;
  cookingCount: number;
}) {
  return (
    <li className="rounded-xl border border-dashed border-op-border bg-op-bg p-3">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
          {r.order.shortCode} · R{r.seq} · Fuertes
        </div>
        <span className="font-mono text-[9px] tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
          Fuertes juntos
        </span>
      </div>
      <div className="mt-2 text-xs text-op-muted">
        Esperando cocina · {cookingCount}{" "}
        {cookingCount === 1 ? "fuerte" : "fuertes"} en curso
      </div>
    </li>
  );
}

function MainsBulkCard({
  round: r,
  items,
  onServe,
}: {
  round: Round;
  items: Item[];
  onServe: () => void;
}) {
  return (
    <li className="rounded-xl border-2 border-[#2E6B4C]/50 bg-[#2E6B4C]/5 p-3">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
          {r.order.shortCode} · R{r.seq} · Fuertes juntos
        </div>
        {r.readyAt && <PassTimer readyAt={r.readyAt} />}
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {items.map((i) => (
          <li key={i.id} className="flex items-start gap-2">
            <div className="flex-1">
              <span className="font-mono">{i.qty}×</span> {i.name}
              {i.modifiers.length > 0 && (
                <span className="text-op-muted"> · {i.modifiers.join(" · ")}</span>
              )}
              {i.notes && (
                <div className="text-xs italic text-terracotta mt-0.5">
                  “{i.notes}”
                </div>
              )}
            </div>
            {i.guestName && (
              <span className="shrink-0 font-mono text-[10px] tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
                {i.guestName}
              </span>
            )}
          </li>
        ))}
      </ul>
      <button
        onClick={onServe}
        className="mt-3 w-full h-11 rounded-xl bg-ok text-bone text-sm font-medium active:scale-[0.98] transition-transform"
      >
        Entregado a Mesa {r.order.tableNumber}
      </button>
    </li>
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
      {mins < 1 ? "ahora" : `${mins}m`}
    </span>
  );
}
