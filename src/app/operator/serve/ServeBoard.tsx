"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

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

type CashPending = {
  id: string;
  amountCents: number;
  createdAt: string;
  order: {
    id: string;
    shortCode: string;
    tableNumber: number;
  };
};

export function ServeBoard({
  tenantSlug,
  rounds,
  cashPending,
}: {
  tenantSlug: string;
  rounds: Round[];
  cashPending: CashPending[];
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [pendingServed, setPendingServed] = useState<Set<string>>(new Set());
  const [settlingId, setSettlingId] = useState<string | null>(null);

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
        if (data.type === "order.cash_requested") {
          try {
            navigator.vibrate?.([80, 40, 80, 40, 80]);
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

  const settling = cashPending.find((c) => c.id === settlingId) ?? null;

  if (tables.length === 0 && cashPending.length === 0) {
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
          {cashPending.length > 0 && (
            <>
              {cashPending.length}{" "}
              {cashPending.length === 1 ? "cobro efectivo" : "cobros efectivo"}
              {" · "}
            </>
          )}
          {totalReady} {totalReady === 1 ? "plato listo" : "platos listos"} ·{" "}
          {tables.length} {tables.length === 1 ? "mesa" : "mesas"}
        </div>
      </div>

      {cashPending.length > 0 && (
        <section className="mb-6">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-terracotta mb-2">
            Cobros en efectivo
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {cashPending.map((c) => (
              <CashCard
                key={c.id}
                pending={c}
                onSettle={() => setSettlingId(c.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {tables.length > 0 && (
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
      )}

      {settling && (
        <CashSettleModal
          pending={settling}
          onClose={() => setSettlingId(null)}
          onDone={() => {
            setSettlingId(null);
            startTx(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

function CashCard({
  pending,
  onSettle,
}: {
  pending: CashPending;
  onSettle: () => void;
}) {
  return (
    <li className="rounded-2xl border-2 border-terracotta/50 bg-terracotta/5 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-display text-2xl">
            Mesa {pending.order.tableNumber}
          </div>
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {pending.order.shortCode}
          </div>
        </div>
        <CashAge createdAt={pending.createdAt} />
      </div>
      <div>
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
          Cobrar
        </div>
        <div className="font-display text-3xl tabular">
          {fmtCOP(pending.amountCents)}
        </div>
      </div>
      <button
        onClick={onSettle}
        className="h-11 rounded-xl bg-terracotta text-bone text-sm font-medium active:scale-[0.98] transition-transform"
      >
        Registrar cobro
      </button>
    </li>
  );
}

function CashAge({ createdAt }: { createdAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const mins = Math.floor((now - new Date(createdAt).getTime()) / 60000);
  const tint =
    mins >= 5 ? "text-danger" : mins >= 2 ? "text-[#C98A2E]" : "text-op-muted";
  return (
    <span className={"font-mono text-xs tabular " + tint}>
      {mins < 1 ? "ahora" : `${mins}m`}
    </span>
  );
}

function CashSettleModal({
  pending,
  onClose,
  onDone,
}: {
  pending: CashPending;
  onClose: () => void;
  onDone: () => void;
}) {
  const due = pending.amountCents;
  const [receivedCop, setReceivedCop] = useState<string>(
    String(Math.round(due / 100)),
  );
  const [changeCop, setChangeCop] = useState<string>("0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const receivedCents = Math.round(Number(receivedCop || 0) * 100);
  const changeCents = Math.round(Number(changeCop || 0) * 100);
  const net = receivedCents - changeCents;
  const extra = Math.max(0, net - due);
  const short = net < due;

  function setReceivedSmart(v: string) {
    setReceivedCop(v);
    const nextReceived = Math.round(Number(v || 0) * 100);
    // Suggest exact change by default so the common case is one-tap.
    const suggested = Math.max(0, nextReceived - due);
    setChangeCop(String(Math.round(suggested / 100)));
  }

  async function submit() {
    if (short) {
      setErr("Recibido insuficiente.");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(
      `/api/operator/payments/${pending.id}/settle-cash`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cashReceivedCents: receivedCents,
          changeGivenCents: changeCents,
        }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No se pudo registrar el cobro.");
      return;
    }
    onDone();
  }

  return (
    <div
      className="fixed inset-0 z-20 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              Mesa {pending.order.tableNumber} · {pending.order.shortCode}
            </div>
            <div className="font-display text-2xl">Cobro en efectivo</div>
          </div>
          <button
            onClick={onClose}
            className="text-op-muted font-mono text-xs"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <div className="rounded-xl bg-op-bg border border-op-border p-3 flex items-baseline justify-between">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            Total a cobrar
          </span>
          <span className="font-display text-3xl tabular">{fmtCOP(due)}</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              Recibido (COP)
            </span>
            <input
              type="number"
              inputMode="numeric"
              value={receivedCop}
              onChange={(e) => setReceivedSmart(e.target.value)}
              min={0}
              step={1000}
              className="h-12 px-3 rounded-xl border border-op-border bg-op-bg font-mono text-xl tabular"
            />
          </label>
          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              Devuelta (COP)
            </span>
            <input
              type="number"
              inputMode="numeric"
              value={changeCop}
              onChange={(e) => setChangeCop(e.target.value)}
              min={0}
              step={1000}
              className="h-12 px-3 rounded-xl border border-op-border bg-op-bg font-mono text-xl tabular"
            />
          </label>
        </div>

        <div className="rounded-xl border border-dashed border-op-border p-3 text-sm flex items-center justify-between">
          <span className="text-op-muted">
            {short
              ? "Falta"
              : extra > 0
                ? "Propina adicional"
                : "Cambio justo"}
          </span>
          <span
            className={
              "font-mono tabular " +
              (short
                ? "text-danger"
                : extra > 0
                  ? "text-[#7F5A1F]"
                  : "text-op-muted")
            }
          >
            {short ? fmtCOP(due - net) : extra > 0 ? "+ " + fmtCOP(extra) : "—"}
          </span>
        </div>
        {extra > 0 && (
          <div className="text-[11px] text-op-muted">
            Se guardará como propina extra para el cierre de turno.
          </div>
        )}

        {err && <div className="text-danger text-sm">{err}</div>}

        <button
          onClick={submit}
          disabled={busy || short}
          className="w-full h-12 rounded-full bg-ok text-bone text-sm font-medium disabled:opacity-60"
        >
          {busy ? "Registrando…" : "Confirmar cobro"}
        </button>
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
