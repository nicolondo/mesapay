"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

type CategoryKind = "starter" | "main" | "side" | "drink" | "dessert" | "other";

type Station = "kitchen" | "bar" | "counter";

type Item = {
  id: string;
  qty: number;
  name: string;
  modifiers: string[];
  notes: string | null;
  guestName: string | null;
  kitchenStatus: "placed" | "in_kitchen" | "ready";
  categoryKind: CategoryKind;
  station: Station;
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
    orderType: "dineIn" | "pickup";
    pickupName: string | null;
    etaMinutes: number | null;
    readyEta: string | null;
  };
  items: Item[];
};

type CashPending = {
  id: string;
  amountCents: number;
  tipCents: number;
  // What the diner said they'd pay with (null if they skipped the prompt).
  cashTenderCents: number | null;
  createdAt: string;
  order: {
    id: string;
    shortCode: string;
    tableNumber: number;
  };
};

type WaiterCall = {
  // `order`: legacy/active-order call (id = orderId).
  // `table`: pre-orden call (id = "table:<tableId>" para discriminar
  // el ack — el handler ackWaiter extrae el tableId y pega al
  // endpoint correspondiente).
  id: string;
  shortCode: string;
  tableNumber: number;
  calledAt: string;
  scope?: "order" | "table";
};

type CancelledPending = {
  id: string;
  seq: number;
  cancelledAt: string | null;
  reason: string;
  order: {
    id: string;
    shortCode: string;
    tableNumber: number;
    orderType: "dineIn" | "pickup";
    pickupName: string | null;
  };
  items: { id: string; qty: number; name: string }[];
};

type TerminalPending = {
  id: string;
  // Distingue Smart POS Kushki (push cloud) vs datáfono externo del
  // comercio (cobro manual desde POS físico propio). Cambia la UX
  // del card: Kushki tiene botón "Enviar al datáfono", externo
  // tiene botones "Aprobado / Rechazado" porque el mesero ya cobró
  // físicamente y sólo reporta el resultado.
  method: "kushki_card_terminal" | "external_terminal";
  amountCents: number;
  tipCents: number;
  createdAt: string;
  order: {
    id: string;
    shortCode: string;
    tableNumber: number;
  };
};

export function ServeBoard({
  tenantSlug,
  serviceMode,
  rounds,
  cashPending,
  waiterCalls,
  cancelledPending,
  terminalPending,
  device,
}: {
  tenantSlug: string;
  serviceMode: "table" | "counter";
  rounds: Round[];
  cashPending: CashPending[];
  waiterCalls: WaiterCall[];
  cancelledPending: CancelledPending[];
  terminalPending: TerminalPending[];
  device: { id: string; label: string } | null;
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [pendingServed, setPendingServed] = useState<Set<string>>(new Set());
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [ackingId, setAckingId] = useState<string | null>(null);

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
        if (data.type === "order.waiter_called") {
          try {
            navigator.vibrate?.([160, 60, 160]);
          } catch {}
        }
        if (data.type === "order.round_cancelled") {
          // Distinct buzz pattern so the waiter feels "go tell the table"
          // even without looking at the screen.
          try {
            navigator.vibrate?.([200, 80, 200, 80, 200]);
          } catch {}
        }
        if (data.type === "order.terminal_requested") {
          // Same urgency as a cash request — the cashier/operator needs
          // to grab the datáfono and head to the table.
          try {
            navigator.vibrate?.([150, 50, 150, 50, 150]);
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
    // Secuencial, no Promise.all. La PATCH server-side abre una
    // transacción que lee siblings para decidir si el round entero
    // queda "served". Si dos PATCHes corren en paralelo, ambas leen
    // los siblings de la otra todavía con servedAt=null, ambas
    // calculan allServed=false, y el round queda zombie en "ready"
    // aunque los dos items quedan marcados servidos. Serializar
    // garantiza que la última PATCH ve a las anteriores ya commited.
    for (const i of pending) {
      await fetch(`/api/operator/order-items/${i.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ served: true }),
      });
    }
    startTx(() => router.refresh());
  }

  // In "table" mode we bundle every open round for a table into one card so
  // the waiter sees "all of mesa 3" at a glance. In "counter" mode every
  // physical order is independent (no shared bill, no waiter walking to a
  // seat), so we group by order instead. Pickup orders always group per-order
  // — the fake table (-1) would otherwise lump every pickup together.
  const groupKey = (r: Round) =>
    r.order.orderType === "pickup" || serviceMode === "counter"
      ? r.order.id
      : String(r.order.tableNumber);
  const groupLabel = (r: Round) =>
    r.order.orderType === "pickup"
      ? `Pickup · ${r.order.pickupName ?? r.order.shortCode}`
      : serviceMode === "counter"
        ? `Orden ${r.order.shortCode}`
        : `Mesa ${r.order.tableNumber}`;

  const byGroup = new Map<string, { label: string; sort: number; rounds: Round[] }>();
  for (const r of rounds) {
    const key = groupKey(r);
    const entry = byGroup.get(key);
    if (entry) {
      entry.rounds.push(r);
    } else {
      byGroup.set(key, {
        label: groupLabel(r),
        sort:
          r.order.orderType === "pickup" || serviceMode === "counter"
            ? new Date(r.readyAt ?? 0).getTime()
            : r.order.tableNumber,
        rounds: [r],
      });
    }
  }
  const groups = Array.from(byGroup.values()).sort((a, b) => a.sort - b.sort);

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

  async function ackWaiter(callId: string) {
    setAckingId(callId);
    // callId puede ser "<orderId>" o "table:<tableId>" — discriminamos
    // para pegarle al endpoint correcto.
    const isTable = callId.startsWith("table:");
    const url = isTable
      ? `/api/operator/tables/${callId.slice("table:".length)}/ack-waiter`
      : `/api/operator/orders/${callId}/ack-waiter`;
    await fetch(url, { method: "POST" });
    setAckingId(null);
    startTx(() => router.refresh());
  }

  const [chargingPaymentId, setChargingPaymentId] = useState<string | null>(
    null,
  );

  const [ackingCancelId, setAckingCancelId] = useState<string | null>(null);
  async function ackCancellation(roundId: string) {
    setAckingCancelId(roundId);
    await fetch(`/api/operator/rounds/${roundId}/ack-cancellation`, {
      method: "POST",
    });
    setAckingCancelId(null);
    startTx(() => router.refresh());
  }

  if (
    groups.length === 0 &&
    cashPending.length === 0 &&
    terminalPending.length === 0 &&
    waiterCalls.length === 0 &&
    cancelledPending.length === 0
  ) {
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
          {waiterCalls.length > 0 && (
            <>
              {waiterCalls.length}{" "}
              {waiterCalls.length === 1 ? "llamada" : "llamadas"}
              {" · "}
            </>
          )}
          {terminalPending.length > 0 && (
            <>
              {terminalPending.length}{" "}
              {terminalPending.length === 1 ? "datáfono" : "datáfonos"} ·{" "}
            </>
          )}
          {cashPending.length > 0 && (
            <>
              {cashPending.length}{" "}
              {cashPending.length === 1 ? "cobro efectivo" : "cobros efectivo"}
              {" · "}
            </>
          )}
          {totalReady} {totalReady === 1 ? "plato listo" : "platos listos"} ·{" "}
          {groups.length}{" "}
          {serviceMode === "counter"
            ? groups.length === 1
              ? "orden"
              : "órdenes"
            : groups.length === 1
              ? "mesa"
              : "mesas"}
        </div>
      </div>

      {cancelledPending.length > 0 && (
        <section className="mb-6">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-danger mb-2">
            Cancelaciones de cocina · avisar al cliente
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {cancelledPending.map((c) => (
              <CancelledCard
                key={c.id}
                cancelled={c}
                serviceMode={serviceMode}
                busy={ackingCancelId === c.id}
                onAck={() => ackCancellation(c.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {waiterCalls.length > 0 && (
        <section className="mb-6">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-terracotta mb-2">
            Llamadas pendientes
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {waiterCalls.map((w) => (
              <WaiterCallCard
                key={w.id}
                call={w}
                serviceMode={serviceMode}
                busy={ackingId === w.id}
                onAck={() => ackWaiter(w.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {terminalPending.length > 0 && (
        <section className="mb-6">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-terracotta mb-2">
            📱 Pidió datáfono
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {terminalPending.map((p) => (
              <TerminalPendingCard
                key={p.id}
                pending={p}
                serviceMode={serviceMode}
                tenantSlug={tenantSlug}
                device={device}
                busy={chargingPaymentId === p.id}
                onCharged={() => startTx(() => router.refresh())}
                onBusyChange={setChargingPaymentId}
              />
            ))}
          </ul>
        </section>
      )}

      {cashPending.length > 0 && (
        <section className="mb-6">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-[#1E5339] mb-2">
            💵 Cobros en efectivo
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {cashPending.map((c) => (
              <CashCard
                key={c.id}
                pending={c}
                serviceMode={serviceMode}
                onSettle={() => setSettlingId(c.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {groups.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {groups.map((g) => (
            <div
              key={g.label}
              className="border border-op-border rounded-2xl bg-op-surface flex flex-col"
            >
              <div className="px-4 py-3 border-b border-op-border flex items-center justify-between">
                <div className="font-display text-2xl">{g.label}</div>
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
                  {g.rounds.length}{" "}
                  {g.rounds.length === 1 ? "ronda" : "rondas"}
                </div>
              </div>
              <ul className="p-3 space-y-3">
                {g.rounds.map((r) => (
                  <RoundCard
                    key={r.id}
                    round={r}
                    serviceMode={serviceMode}
                    pendingServed={pendingServed}
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
          serviceMode={serviceMode}
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

function CancelledCard({
  cancelled,
  serviceMode,
  busy,
  onAck,
}: {
  cancelled: CancelledPending;
  serviceMode: "table" | "counter";
  busy: boolean;
  onAck: () => void;
}) {
  const title =
    cancelled.order.orderType === "pickup"
      ? `Pickup · ${cancelled.order.pickupName ?? cancelled.order.shortCode}`
      : serviceMode === "counter"
        ? `Orden ${cancelled.order.shortCode}`
        : `Mesa ${cancelled.order.tableNumber} · ${cancelled.order.shortCode}`;
  return (
    <li className="rounded-2xl border-2 border-danger/40 bg-danger/5 p-4 flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] tracking-wider uppercase text-danger truncate">
          {title}
        </div>
        {cancelled.cancelledAt && (
          <span className="font-mono text-[10px] text-op-muted shrink-0">
            {timeAgo(cancelled.cancelledAt)}
          </span>
        )}
      </div>
      <div className="mt-2 text-sm">
        <ul className="space-y-0.5">
          {cancelled.items.map((i) => (
            <li key={i.id} className="line-through text-op-muted">
              {i.qty}× {i.name}
            </li>
          ))}
        </ul>
      </div>
      {cancelled.reason && (
        <div className="mt-2 text-xs text-ink-3">
          Motivo:{" "}
          <span className="italic">{cancelled.reason}</span>
        </div>
      )}
      <div className="text-[11px] text-op-muted mt-2">
        Ve a la mesa y avísale al cliente.
      </div>
      <button
        type="button"
        onClick={onAck}
        disabled={busy}
        className="mt-3 h-9 px-4 rounded-full bg-danger text-bone text-sm font-medium disabled:opacity-50"
      >
        {busy ? "Confirmando…" : "Avisé al cliente"}
      </button>
    </li>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

function WaiterCallCard({
  call,
  serviceMode,
  busy,
  onAck,
}: {
  call: WaiterCall;
  serviceMode: "table" | "counter";
  busy: boolean;
  onAck: () => void;
}) {
  return (
    <li className="rounded-2xl border-2 border-terracotta/50 bg-terracotta/10 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-display text-2xl">
            {serviceMode === "counter"
              ? `Orden ${call.shortCode}`
              : `Mesa ${call.tableNumber}`}
          </div>
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {call.shortCode}
          </div>
        </div>
        <CashAge createdAt={call.calledAt} />
      </div>
      <div className="flex items-center gap-2 text-sm text-ink">
        <span className="w-7 h-7 rounded-full bg-terracotta/25 text-terracotta inline-flex items-center justify-center shrink-0">
          <BellIcon />
        </span>
        <span>Solicitan un mesero</span>
      </div>
      <button
        onClick={onAck}
        disabled={busy}
        className="h-11 rounded-xl bg-terracotta text-bone text-sm font-medium active:scale-[0.98] transition-transform disabled:opacity-60"
      >
        {busy ? "Atendiendo…" : "Voy en camino"}
      </button>
    </li>
  );
}

function BellIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function TerminalPendingCard({
  pending,
  serviceMode,
  tenantSlug,
  device,
  busy,
  onCharged,
  onBusyChange,
}: {
  pending: TerminalPending;
  serviceMode: "table" | "counter";
  tenantSlug: string;
  device: { id: string; label: string } | null;
  busy: boolean;
  onCharged: () => void;
  onBusyChange: (id: string | null) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  // pending.amountCents YA es el TOTAL (food + tip).
  const total = pending.amountCents;
  const isExternal = pending.method === "external_terminal";
  const title =
    serviceMode === "counter"
      ? `Orden ${pending.order.shortCode}`
      : `Mesa ${pending.order.tableNumber} · ${pending.order.shortCode}`;

  async function charge() {
    if (!device) {
      setErr(
        "No hay un datáfono activo registrado. Pídele al admin que registre uno en /admin.",
      );
      return;
    }
    onBusyChange(pending.id);
    setErr(null);
    const res = await fetch(`/api/tenant/${tenantSlug}/terminal/charge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId: pending.id, deviceId: device.id }),
    });
    onBusyChange(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos enviar al datáfono.");
      return;
    }
    onCharged();
  }

  /**
   * Settle de external_terminal: el mesero ya cobró con su POS
   * propio y reporta el resultado. No hay push a ningún hardware,
   * es sólo marcar approved o declined en MESAPAY.
   */
  async function settleExternal(action: "approve" | "decline") {
    onBusyChange(pending.id);
    setErr(null);
    const res = await fetch(
      `/api/operator/payments/${pending.id}/settle-external-terminal`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      },
    );
    onBusyChange(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos marcar el cobro.");
      return;
    }
    onCharged();
  }

  return (
    <li className="rounded-2xl border-2 border-terracotta bg-terracotta/10 p-4 flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] tracking-wider uppercase text-terracotta truncate">
          {title}
        </div>
        <span className="font-mono text-[10px] text-op-muted shrink-0">
          {timeAgoStr(pending.createdAt)}
        </span>
      </div>
      {isExternal && (
        <div className="font-mono text-[9px] tracking-wider uppercase text-op-muted mt-1">
          Datáfono propio del comercio
        </div>
      )}
      <div className="mt-2 flex items-baseline justify-between">
        <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
          Cobrar
        </span>
        <span className="font-display text-3xl tabular text-terracotta">
          {fmtCOP(total)}
        </span>
      </div>
      {pending.tipCents > 0 && (
        <div className="text-[11px] text-op-muted mt-0.5 text-right">
          Incluye propina {fmtCOP(pending.tipCents)}
        </div>
      )}
      <div className="text-[11px] text-op-muted mt-2">
        {isExternal
          ? "Pasa la tarjeta por tu datáfono y reporta el resultado."
          : 'Lleva el datáfono a la mesa y presiona "Cobrar".'}
      </div>
      {err && <div className="mt-1 text-[11px] text-danger">{err}</div>}
      {isExternal ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => settleExternal("decline")}
            disabled={busy}
            className="h-10 rounded-full border border-op-border bg-paper text-ink text-sm disabled:opacity-60"
          >
            Rechazado
          </button>
          <button
            type="button"
            onClick={() => settleExternal("approve")}
            disabled={busy}
            className="h-10 rounded-full bg-terracotta text-bone font-medium text-sm disabled:opacity-60"
          >
            {busy ? "…" : "Aprobado"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={charge}
          disabled={busy}
          className="mt-3 h-10 rounded-full bg-terracotta text-bone font-medium text-sm disabled:opacity-60"
        >
          {busy ? "Enviando al datáfono…" : `Cobrar ${fmtCOP(total)}`}
        </button>
      )}
    </li>
  );
}

function timeAgoStr(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function CashCard({
  pending,
  serviceMode,
  onSettle,
}: {
  pending: CashPending;
  serviceMode: "table" | "counter";
  onSettle: () => void;
}) {
  return (
    <li className="rounded-2xl border-2 border-terracotta/50 bg-terracotta/5 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-display text-2xl">
            {serviceMode === "counter"
              ? `Orden ${pending.order.shortCode}`
              : `Mesa ${pending.order.tableNumber}`}
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
      {pending.cashTenderCents != null &&
        pending.cashTenderCents >= pending.amountCents && (
          <div className="rounded-lg border border-[#7F5A1F]/40 bg-[#C98A2E]/15 p-2.5 text-[12px]">
            <div className="font-medium text-[#7F5A1F]">
              Pagará con {fmtCOP(pending.cashTenderCents)}
            </div>
            {pending.cashTenderCents > pending.amountCents && (
              <div className="text-ink-3 mt-0.5">
                Lleva{" "}
                <span className="font-mono tabular font-semibold">
                  {fmtCOP(pending.cashTenderCents - pending.amountCents)}
                </span>{" "}
                de devuelta
              </div>
            )}
          </div>
        )}
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
  serviceMode,
  onClose,
  onDone,
}: {
  pending: CashPending;
  serviceMode: "table" | "counter";
  onClose: () => void;
  onDone: () => void;
}) {
  const due = pending.amountCents;
  // If the diner declared a tender amount up front, pre-fill recibido +
  // devuelta with the expected change. Waiter can still overwrite.
  const initialReceived =
    pending.cashTenderCents != null && pending.cashTenderCents >= due
      ? pending.cashTenderCents
      : due;
  const initialChange = Math.max(0, initialReceived - due);
  const [receivedCop, setReceivedCop] = useState<string>(
    String(Math.round(initialReceived / 100)),
  );
  const [changeCop, setChangeCop] = useState<string>(
    String(Math.round(initialChange / 100)),
  );
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

  // Quick presets so a busy waiter doesn't have to type the common bills.
  // Each preset only makes sense when it covers the bill.
  const COMMON_BILLS_COP = [
    Math.ceil(due / 100 / 1000) * 1000, // smallest round that covers
    50000,
    100000,
    200000,
  ]
    .filter((v, i, a) => v * 100 >= due && a.indexOf(v) === i)
    .slice(0, 4);

  function applyExact() {
    setReceivedCop(String(Math.round(due / 100)));
    setChangeCop("0");
  }
  function applyKeepChange() {
    // "Que se quede con el cambio" — receivedCop stays as the operator
    // entered it (whatever bill the customer handed over), devuelta = 0
    // so the difference flows to propina.
    setChangeCop("0");
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
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {serviceMode === "counter"
                ? `Orden ${pending.order.shortCode}`
                : `Mesa ${pending.order.tableNumber} · ${pending.order.shortCode}`}
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

        {/* Quick presets — saves the waiter from typing on the phone. */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={applyExact}
            className="h-8 px-3 rounded-full bg-op-bg border border-op-border text-xs font-medium hover:border-ok"
          >
            Pagó exacto
          </button>
          {COMMON_BILLS_COP.map((bill) => (
            <button
              key={bill}
              type="button"
              onClick={() => setReceivedSmart(String(bill))}
              className="h-8 px-3 rounded-full bg-op-bg border border-op-border text-xs font-medium hover:border-ok"
            >
              Recibió ${bill.toLocaleString("es-CO")}
            </button>
          ))}
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

        {/* Big "keep the change → propina" button. When the diner says
            "quédate con el cambio", one tap zeroes devuelta and the whole
            difference (recibido − total) flows into the tip ledger. */}
        {receivedCents > due && changeCents > 0 && (
          <button
            type="button"
            onClick={applyKeepChange}
            className="w-full h-11 rounded-xl border-2 border-dashed border-[#7F5A1F] bg-[#C98A2E]/10 text-[#7F5A1F] font-medium text-sm hover:bg-[#C98A2E]/20"
          >
            💛 Que se quede con el cambio · propina{" "}
            {fmtCOP(receivedCents - due)}
          </button>
        )}

        <div className="rounded-xl border border-dashed border-op-border p-3 text-sm flex items-center justify-between">
          <span className="text-op-muted">
            {short
              ? "Falta"
              : extra > 0
                ? "💛 Propina"
                : "Cambio justo"}
          </span>
          <span
            className={
              "font-mono tabular " +
              (short
                ? "text-danger"
                : extra > 0
                  ? "text-[#7F5A1F] font-display text-lg"
                  : "text-op-muted")
            }
          >
            {short ? fmtCOP(due - net) : extra > 0 ? "+ " + fmtCOP(extra) : "—"}
          </span>
        </div>
        {extra > 0 && (
          <div className="text-[11px] text-op-muted">
            La propina se guarda en el pago para el cierre de turno y los
            reportes. No tiene nada que ver con Kushki.
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
  serviceMode,
  pendingServed,
  onServeItems,
}: {
  round: Round;
  serviceMode: "table" | "counter";
  pendingServed: Set<string>;
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
      {loose.length > 0 && (
        <LooseItemsCard
          round={r}
          serviceMode={serviceMode}
          items={loose}
          onServe={onServeItems}
        />
      )}

      {fuertesJuntos && !mainsAllReady && mainsReadyUnserved.length > 0 && (
        <MainsWaitingCard round={r} cookingCount={mainsCooking} />
      )}

      {fuertesJuntos && mainsAllReady && mainsUnserved.length > 0 && (
        <MainsBulkCard
          round={r}
          serviceMode={serviceMode}
          items={mainsUnserved}
          onServe={() => onServeItems(mainsUnserved)}
        />
      )}
    </>
  );
}

function LooseItemsCard({
  // Multi-item card with a checkbox per dish (default checked) and a
  // single "Entregar N" button at the bottom. Matches how a waiter
  // physically picks up dishes — they grab everything for a table at
  // once, and only uncheck a plate if they're holding it back (still
  // arranging, customer asked to delay, etc.). For a single-item
  // round the checkbox still shows but the friction is minimal.
  round: r,
  serviceMode,
  items,
  onServe,
}: {
  round: Round;
  serviceMode: "table" | "counter";
  items: Item[];
  onServe: (items: Item[]) => void;
}) {
  const isPickup = r.order.orderType === "pickup";

  // Selection state. Default: all items checked.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(items.map((i) => i.id)),
  );
  const currentIds = useMemo(() => items.map((i) => i.id), [items]);
  // Snapshot of what the props looked like last render — used to tell
  // "items just got delivered" (shrink) apart from "a new item arrived"
  // (grow). Different reactions to each.
  const prevIdsRef = useRef<string[]>(currentIds);
  useEffect(() => {
    const prevIds = prevIdsRef.current;
    const prevSet = new Set(prevIds);
    const someRemoved = prevIds.some((id) => !currentIds.includes(id));
    if (someRemoved) {
      // A delivery just landed (the items we sent disappeared from the
      // round). Reset to "all remaining items checked" so the dishes
      // the waiter held back are queued up for the next trip without
      // them having to re-tick.
      setSelected(new Set(currentIds));
    } else {
      // Pure addition (new item became ready while the card is open).
      // Keep whatever the user already toggled and default newcomers
      // to checked so the bulk button stays usable.
      setSelected((prev) => {
        const next = new Set<string>();
        for (const id of currentIds) {
          if (prevSet.has(id)) {
            if (prev.has(id)) next.add(id);
          } else {
            next.add(id);
          }
        }
        return next;
      });
    }
    prevIdsRef.current = currentIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIds.join(",")]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAll(value: boolean) {
    setSelected(value ? new Set(currentIds) : new Set());
  }

  const selectedItems = items.filter((i) => selected.has(i.id));
  const allChecked = selectedItems.length === items.length;
  const noneChecked = selectedItems.length === 0;

  return (
    <li className="rounded-xl border-2 border-[#2E6B4C]/50 bg-[#2E6B4C]/5 p-3">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted truncate">
          {isPickup
            ? `Pickup · ${r.order.pickupName ?? r.order.shortCode}`
            : `${r.order.shortCode} · R${r.seq}`}
        </div>
        {r.readyAt && <PassTimer readyAt={r.readyAt} />}
      </div>

      <ul className="mt-2 space-y-2">
        {items.map((i) => {
          const checked = selected.has(i.id);
          return (
            <li key={i.id} className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => toggle(i.id)}
                aria-pressed={checked}
                aria-label={
                  checked ? `Quitar ${i.name}` : `Agregar ${i.name}`
                }
                className={
                  "mt-0.5 w-5 h-5 shrink-0 rounded border-2 flex items-center justify-center transition-colors " +
                  (checked
                    ? "bg-ok border-ok text-bone"
                    : "bg-paper border-op-border text-transparent")
                }
              >
                ✓
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-sm">
                  <span className="font-mono">{i.qty}×</span> {i.name}
                </div>
                {i.modifiers.length > 0 && (
                  <div className="text-xs text-op-muted mt-0.5 space-y-0.5">
                    {i.modifiers.map((g, idx) => (
                      <div key={idx}>- {g}</div>
                    ))}
                  </div>
                )}
                {i.notes && (
                  <div className="text-xs italic text-terracotta mt-0.5">
                    “{i.notes}”
                  </div>
                )}
                <StationPill station={i.station} />
              </div>
              {i.guestName && !isPickup && (
                <span className="shrink-0 font-mono text-[10px] tracking-wider uppercase text-terracotta bg-terracotta/10 px-1.5 py-0.5 rounded">
                  {i.guestName}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {items.length > 1 && (
        <button
          type="button"
          onClick={() => selectAll(!allChecked)}
          className="mt-2 text-[11px] font-mono tracking-wider uppercase text-op-muted hover:text-ink"
        >
          {allChecked ? "Desmarcar todo" : "Marcar todo"}
        </button>
      )}

      <button
        onClick={() => onServe(selectedItems)}
        disabled={noneChecked}
        className="mt-3 w-full h-11 rounded-xl bg-ok text-bone text-sm font-medium active:scale-[0.98] transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {noneChecked
          ? "Selecciona los platos a entregar"
          : isPickup
            ? `Entregado a ${r.order.pickupName ?? r.order.shortCode}${selectedItems.length > 1 ? ` · ${selectedItems.length}` : ""}`
            : serviceMode === "counter"
              ? `Entregado${selectedItems.length > 1 ? ` · ${selectedItems.length}` : ""}`
              : `Entregar ${selectedItems.length}${selectedItems.length === 1 ? "" : ""}`}
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
  serviceMode,
  items,
  onServe,
}: {
  round: Round;
  serviceMode: "table" | "counter";
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
                <div className="text-xs text-op-muted mt-0.5 space-y-0.5">
                  {i.modifiers.map((g, idx) => (
                    <div key={idx}>- {g}</div>
                  ))}
                </div>
              )}
              {i.notes && (
                <div className="text-xs italic text-terracotta mt-0.5">
                  “{i.notes}”
                </div>
              )}
              <StationPill station={i.station} />
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
        {serviceMode === "counter"
          ? `Entregado a ${r.order.shortCode}`
          : `Entregado a Mesa ${r.order.tableNumber}`}
      </button>
    </li>
  );
}

/**
 * Tiny pill that tells the waiter where to grab a non-kitchen item from.
 * For kitchen items we render nothing — that's the default and the
 * waiter knows to head to the pass without a label.
 */
function StationPill({ station }: { station: Station }) {
  if (station === "kitchen") return null;
  if (station === "bar") {
    return (
      <span className="inline-flex items-center gap-1 mt-1 font-mono text-[10px] tracking-wider uppercase text-[#7F5A1F] bg-[#C98A2E]/15 px-1.5 py-0.5 rounded">
        🍷 Barra
      </span>
    );
  }
  // counter
  return (
    <span className="inline-flex items-center gap-1 mt-1 font-mono text-[10px] tracking-wider uppercase text-[#2E6B4C] bg-[#2E6B4C]/10 px-1.5 py-0.5 rounded">
      🧊 Refri
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
      {mins < 1 ? "ahora" : `${mins}m`}
    </span>
  );
}
