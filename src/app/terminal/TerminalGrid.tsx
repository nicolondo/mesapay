"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";
import { useVisibleEventSource } from "@/lib/useVisibleEventSource";

export type TableState =
  | "free"
  | "occupied"
  | "partial"
  | "charging"
  | "terminal_requested"
  | "cash_requested"
  | "paid";

export type PendingPayment = {
  id: string;
  method: string;
  amountCents: number;
  tipCents: number;
  // Only set for cash payments where the diner declared upfront.
  cashTenderCents: number | null;
  createdAt: string;
};

export type GuestGroup = {
  name: string;
  subtotalCents: number;
  items: { id: string; name: string; qty: number; priceCents: number }[];
};

export type OrderItem = {
  id: string;
  name: string;
  qty: number;
  priceCents: number;
  guestName: string | null;
};

export type TableCard = {
  tableId: string;
  number: number;
  label: string | null;
  state: TableState;
  orderId: string | null;
  shortCode: string | null;
  subtotalCents: number;
  outstandingCents: number;
  paidCents: number;
  pendingPayments: PendingPayment[];
  pendingTerminalAmountCents: number | null;
  pendingTerminalRequestedAt: string | null;
  pendingCashAmountCents: number | null;
  pendingCashRequestedAt: string | null;
  items: OrderItem[];
  guestGroups: GuestGroup[];
  approvedSummaries: {
    id: string;
    method: string;
    amountCents: number;
    tipCents: number;
    settledAt: string | null;
  }[];
};

export function TerminalGrid({
  tenantSlug,
  tenantName,
  tables,
  device,
}: {
  tenantSlug: string;
  tenantName: string;
  tables: TableCard[];
  device: { id: string; label: string } | null;
}) {
  const router = useRouter();
  const [, startTx] = useTransition();
  const [openTable, setOpenTable] = useState<TableCard | null>(null);

  // Live-refresh via SSE. The grid lives or dies on this — once a payment
  // settles via webhook, we want the colour + amount to change without the
  // operator hitting reload. Visibility-aware: libera el socket cuando la
  // pestaña queda en segundo plano (HTTP/1.1 cap de ~6 conexiones).
  const lastRef = useRef(0);
  const refresh = () => startTx(() => router.refresh());
  useVisibleEventSource(
    `/api/tenant/${tenantSlug}/events`,
    (es) =>
      es.addEventListener("message", () => {
        const now = Date.now();
        if (now - lastRef.current < 600) return;
        lastRef.current = now;
        refresh();
      }),
    refresh,
  );

  // Stats strip at the top — quick scan of the floor.
  const stats = useMemo(() => {
    let free = 0,
      open = 0,
      paid = 0,
      terminalReq = 0,
      cashReq = 0,
      outstanding = 0;
    for (const t of tables) {
      if (t.state === "free") free++;
      else if (t.state === "paid") paid++;
      else open++;
      if (t.state === "terminal_requested") terminalReq++;
      if (t.state === "cash_requested") cashReq++;
      outstanding += t.outstandingCents;
    }
    return { free, open, paid, terminalReq, cashReq, outstanding };
  }, [tables]);

  // Sort: tables that requested action (terminal first, then cash) jump
  // to the front. Within a state, keep numeric order.
  const sortedTables = useMemo(() => {
    return [...tables].sort((a, b) => {
      const stateRank = (s: TableState) =>
        s === "terminal_requested" ? 0 : s === "cash_requested" ? 1 : 2;
      const r = stateRank(a.state) - stateRank(b.state);
      if (r !== 0) return r;
      return a.number - b.number;
    });
  }, [tables]);

  return (
    <div className="px-5 py-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div>
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase opacity-60">
            {tenantName}
          </div>
          <div className="font-display text-3xl">Mesas en vivo</div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {stats.terminalReq > 0 && (
            <Stat
              label="📱 Pidió datáfono"
              value={String(stats.terminalReq)}
              tint="bg-terracotta text-bone"
            />
          )}
          {stats.cashReq > 0 && (
            <Stat
              label="💵 Pidió efectivo"
              value={String(stats.cashReq)}
              tint="bg-[#2E6B4C] text-bone"
            />
          )}
          <Stat label="Libres" value={String(stats.free)} tint="bg-bone/10" />
          <Stat label="Abiertas" value={String(stats.open)} tint="bg-terracotta/20" />
          <Stat label="Pagadas" value={String(stats.paid)} tint="bg-ok/20" />
          <Stat
            label="Por cobrar"
            value={fmtCOP(stats.outstanding)}
            tint="bg-[#C98A2E]/25"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {sortedTables.map((t) => (
          <TableTile key={t.tableId} t={t} onOpen={() => setOpenTable(t)} />
        ))}
      </div>

      {openTable && (
        <DetailSheet
          tenantSlug={tenantSlug}
          table={openTable}
          device={device}
          onClose={() => setOpenTable(null)}
          onChargedQueued={() => {
            setOpenTable(null);
            startTx(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <div className={"rounded-2xl px-4 py-2 " + tint}>
      <div className="font-mono text-[9px] tracking-[0.18em] uppercase opacity-70">
        {label}
      </div>
      <div className="font-display text-xl tabular">{value}</div>
    </div>
  );
}

const STATE_TINT: Record<TableState, string> = {
  free: "bg-bone/5 border-bone/10",
  occupied: "bg-terracotta/15 border-terracotta/40",
  partial: "bg-[#C98A2E]/20 border-[#C98A2E]/50",
  charging: "bg-bone text-ink border-bone",
  // Both "requested" states stand out from the rest — bright bone tile
  // with a thick coloured border so the cashier sees them across the room.
  terminal_requested: "bg-bone text-ink border-terracotta animate-pulse-soft",
  cash_requested: "bg-bone text-ink border-[#2E6B4C] animate-pulse-soft",
  paid: "bg-ok/15 border-ok/40",
};

const STATE_LABEL: Record<TableState, string> = {
  free: "Libre",
  occupied: "Abierta",
  partial: "Pago parcial",
  charging: "Cobrando…",
  terminal_requested: "Pidió datáfono",
  cash_requested: "Pidió efectivo",
  paid: "Pagada",
};

function TableTile({ t, onOpen }: { t: TableCard; onOpen: () => void }) {
  const disabled = t.state === "free";
  const isTerminalReq = t.state === "terminal_requested";
  const isCashReq = t.state === "cash_requested";
  const ringClass = isTerminalReq
    ? " ring-4 ring-terracotta/40 shadow-lg"
    : isCashReq
      ? " ring-4 ring-[#2E6B4C]/40 shadow-lg"
      : "";
  const requestedAmount =
    isTerminalReq
      ? t.pendingTerminalAmountCents
      : isCashReq
        ? t.pendingCashAmountCents
        : null;
  const requestedAt = isTerminalReq
    ? t.pendingTerminalRequestedAt
    : isCashReq
      ? t.pendingCashRequestedAt
      : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className={
        "text-left rounded-2xl border-2 p-4 min-h-[140px] transition-colors disabled:cursor-default disabled:opacity-60 " +
        STATE_TINT[t.state] +
        ringClass
      }
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-display text-2xl">Mesa {t.number}</div>
        {isTerminalReq ? (
          <span className="font-mono text-[10px] tracking-wider uppercase bg-terracotta text-bone px-2 py-0.5 rounded-full shrink-0">
            📱 Pidió datáfono
          </span>
        ) : isCashReq ? (
          <span className="font-mono text-[10px] tracking-wider uppercase bg-[#2E6B4C] text-bone px-2 py-0.5 rounded-full shrink-0">
            💵 Pidió efectivo
          </span>
        ) : (
          <div className="font-mono text-[10px] tracking-wider uppercase opacity-80">
            {STATE_LABEL[t.state]}
          </div>
        )}
      </div>
      {t.shortCode && (
        <div className="font-mono text-[10px] tracking-wider opacity-70 mt-1">
          {t.shortCode}
        </div>
      )}
      {t.state !== "free" && (
        <div className="mt-3">
          {t.state === "paid" ? (
            <div className="font-mono text-xs opacity-70">
              Total {fmtCOP(t.subtotalCents)}
            </div>
          ) : requestedAmount != null ? (
            <>
              <div className="font-mono text-[10px] tracking-wider uppercase opacity-70">
                Cobrar
              </div>
              <div className="font-display text-2xl tabular">
                {fmtCOP(requestedAmount)}
              </div>
              {requestedAt && (
                <div className="text-[11px] opacity-70 mt-0.5">
                  Pedido {timeAgo(requestedAt)}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="font-mono text-[10px] tracking-wider uppercase opacity-70">
                Pendiente
              </div>
              <div className="font-display text-2xl tabular">
                {fmtCOP(t.outstandingCents)}
              </div>
              {t.paidCents > 0 && (
                <div className="text-[11px] opacity-70 mt-0.5">
                  Ya pagado {fmtCOP(t.paidCents)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </button>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "hace nada";
  if (mins < 60) return `hace ${mins}m`;
  return `hace ${Math.floor(mins / 60)}h`;
}

function DetailSheet({
  tenantSlug,
  table,
  device,
  onClose,
  onChargedQueued,
}: {
  tenantSlug: string;
  table: TableCard;
  device: { id: string; label: string } | null;
  onClose: () => void;
  onChargedQueued: () => void;
}) {
  const [busyPaymentId, setBusyPaymentId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Per-payment "settling cash" inline form state. Cash payments don't have
  // a remote terminal to push to — the cashier confirms the bills received
  // and we settle locally via /api/operator/payments/[id]/settle-cash.
  const [cashFormFor, setCashFormFor] = useState<string | null>(null);

  async function chargeTerminal(paymentId: string) {
    if (!device) {
      setErr(
        "No hay un datáfono activo registrado. Pídele al admin que registre uno.",
      );
      return;
    }
    setBusyPaymentId(paymentId);
    setErr(null);
    const res = await fetch(`/api/tenant/${tenantSlug}/terminal/charge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentId, deviceId: device.id }),
    });
    setBusyPaymentId(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos enviar al datáfono.");
      return;
    }
    onChargedQueued();
  }

  async function settleCash(
    paymentId: string,
    cashReceivedCents: number,
    changeGivenCents: number,
  ) {
    setBusyPaymentId(paymentId);
    setErr(null);
    const res = await fetch(
      `/api/operator/payments/${paymentId}/settle-cash`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cashReceivedCents, changeGivenCents }),
      },
    );
    setBusyPaymentId(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos confirmar el efectivo.");
      return;
    }
    setCashFormFor(null);
    onChargedQueued();
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/70 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg bg-bone text-ink rounded-t-3xl md:rounded-3xl max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-hairline flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
              {STATE_LABEL[table.state]}
              {table.shortCode ? ` · ${table.shortCode}` : ""}
            </div>
            <div className="font-display text-xl">Mesa {table.number}</div>
          </div>
          <button onClick={onClose} className="text-muted text-sm">
            Cerrar
          </button>
        </div>

        <div className="p-5 space-y-4">
          {table.state === "paid" ? (
            <div className="rounded-xl border border-ok/30 bg-ok/10 p-4 text-ok">
              <div className="font-display text-lg">Pagada</div>
              <div className="text-sm mt-1">
                Total {fmtCOP(table.subtotalCents)}
              </div>
            </div>
          ) : (
            <>
              {/* Pending payments list — one row per outstanding request.
                  Cash and terminal each get their own action. */}
              {table.pendingPayments.length > 0 && (
                <div className="space-y-2">
                  <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                    Pagos pendientes
                  </div>
                  {table.pendingPayments.map((p) => {
                    // p.amountCents YA incluye la propina (convención
                    // Payment.amountCents = TOTAL). No sumar tipCents.
                    const total = p.amountCents;
                    const isTerminal = p.method === "kushki_card_terminal";
                    const isCash = p.method === "demo_cash";
                    return (
                      <div
                        key={p.id}
                        className={
                          "rounded-xl border-2 p-3 " +
                          (isTerminal
                            ? "border-terracotta bg-terracotta/10"
                            : isCash
                              ? "border-[#2E6B4C] bg-[#2E6B4C]/10"
                              : "border-hairline bg-paper")
                        }
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-lg">
                              {isTerminal ? "📱" : isCash ? "💵" : "💳"}
                            </span>
                            <div>
                              <div className="font-medium text-sm">
                                {humanMethod(p.method)}
                              </div>
                              <div className="text-[11px] text-ink-3">
                                Pedido {timeAgo(p.createdAt)}
                                {p.tipCents > 0
                                  ? ` · propina ${fmtCOP(p.tipCents)}`
                                  : ""}
                              </div>
                            </div>
                          </div>
                          <div className="font-display text-2xl tabular">
                            {fmtCOP(total)}
                          </div>
                        </div>

                        {isCash &&
                          p.cashTenderCents != null &&
                          p.cashTenderCents >= total && (
                            <div className="mt-2 rounded-lg border border-[#7F5A1F]/40 bg-[#C98A2E]/15 p-2 text-[12px]">
                              <div className="font-medium text-[#7F5A1F]">
                                Pagará con {fmtCOP(p.cashTenderCents)}
                              </div>
                              {p.cashTenderCents > total && (
                                <div className="text-ink-3 mt-0.5">
                                  Lleva{" "}
                                  <span className="font-mono tabular font-semibold">
                                    {fmtCOP(p.cashTenderCents - total)}
                                  </span>{" "}
                                  de devuelta
                                </div>
                              )}
                            </div>
                          )}

                        {isTerminal && (
                          <button
                            type="button"
                            onClick={() => chargeTerminal(p.id)}
                            disabled={!!busyPaymentId}
                            className="mt-3 w-full h-11 rounded-full bg-terracotta text-bone font-medium disabled:opacity-60"
                          >
                            {busyPaymentId === p.id
                              ? "Enviando al datáfono…"
                              : `Cobrar ${fmtCOP(total)} con datáfono`}
                          </button>
                        )}

                        {isCash && cashFormFor !== p.id && (
                          <button
                            type="button"
                            onClick={() => setCashFormFor(p.id)}
                            disabled={!!busyPaymentId}
                            className="mt-3 w-full h-11 rounded-full bg-[#2E6B4C] text-bone font-medium disabled:opacity-60"
                          >
                            Confirmar efectivo recibido
                          </button>
                        )}
                        {isCash && cashFormFor === p.id && (
                          <CashConfirmForm
                            owedCents={total}
                            tenderCents={p.cashTenderCents}
                            busy={busyPaymentId === p.id}
                            onCancel={() => setCashFormFor(null)}
                            onConfirm={(received, change) =>
                              settleCash(p.id, received, change)
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Always-visible bill totals */}
              <div className="rounded-xl border border-hairline bg-paper p-4">
                <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                  Pendiente en la cuenta
                </div>
                <div className="font-display text-3xl tabular">
                  {fmtCOP(table.outstandingCents)}
                </div>
                <div className="text-xs text-muted mt-1">
                  Cuenta total {fmtCOP(table.subtotalCents)} · ya pagado{" "}
                  {fmtCOP(table.paidCents)}
                </div>
              </div>

              {/* Order summary — what's on the table. Grouped by guest
                  when names exist, so split-bill is visible at a glance. */}
              {table.items.length > 0 && (
                <div>
                  <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-1">
                    Pedido
                  </div>
                  {table.guestGroups.length > 1 ? (
                    <div className="space-y-2">
                      {table.guestGroups.map((g) => (
                        <div
                          key={g.name}
                          className="rounded-lg border border-hairline bg-paper p-3"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="w-6 h-6 rounded-full bg-terracotta text-bone font-display text-xs inline-flex items-center justify-center">
                                {g.name.charAt(0).toUpperCase()}
                              </span>
                              <div className="font-medium text-sm">{g.name}</div>
                            </div>
                            <div className="font-mono tabular text-sm">
                              {fmtCOP(g.subtotalCents)}
                            </div>
                          </div>
                          <ul className="mt-2 space-y-0.5 text-[12px] text-ink-3">
                            {g.items.map((i) => (
                              <li
                                key={i.id}
                                className="flex justify-between gap-2"
                              >
                                <span className="truncate">
                                  {i.qty}× {i.name}
                                </span>
                                <span className="font-mono tabular shrink-0">
                                  {fmtCOP(i.priceCents * i.qty)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <ul className="rounded-lg border border-hairline bg-paper divide-y divide-hairline">
                      {table.items.map((i) => (
                        <li
                          key={i.id}
                          className="flex justify-between gap-2 px-3 py-2 text-sm"
                        >
                          <span className="truncate">
                            {i.qty}× {i.name}
                            {i.guestName && (
                              <span className="text-terracotta ml-1 text-[11px]">
                                · {i.guestName}
                              </span>
                            )}
                          </span>
                          <span className="font-mono tabular shrink-0">
                            {fmtCOP(i.priceCents * i.qty)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {table.approvedSummaries.length > 0 && (
                <div>
                  <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-1">
                    Pagos previos
                  </div>
                  <ul className="space-y-1 text-sm">
                    {table.approvedSummaries.map((p) => (
                      <li
                        key={p.id}
                        className="flex justify-between bg-paper border border-hairline rounded-lg px-3 py-2"
                      >
                        <span className="truncate">
                          {humanMethod(p.method)}
                          {p.tipCents > 0
                            ? ` · propina ${fmtCOP(p.tipCents)}`
                            : ""}
                        </span>
                        <span className="font-mono tabular">
                          {fmtCOP(p.amountCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {table.pendingPayments.length === 0 && (
                <div className="text-xs text-muted text-center pt-2">
                  El cliente todavía no pidió pagar. Cuando lo haga, aparecerá
                  arriba con el botón para cobrar.
                </div>
              )}
              {err && (
                <div className="text-danger text-sm text-center">{err}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CashConfirmForm({
  owedCents,
  tenderCents,
  busy,
  onCancel,
  onConfirm,
}: {
  owedCents: number;
  tenderCents: number | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (cashReceivedCents: number, changeGivenCents: number) => void;
}) {
  // Prefill from the diner's declared tender if available, falling back to
  // the exact owed amount. Devuelta auto-suggests; operator can override.
  const initialReceived =
    tenderCents != null && tenderCents >= owedCents ? tenderCents : owedCents;
  const [received, setReceived] = useState<number>(initialReceived);
  const [change, setChange] = useState<number>(
    Math.max(0, initialReceived - owedCents),
  );
  // Suggested change updates automatically when "recibido" changes.
  // Operator can override the change field if they round it.
  const suggestedChange = Math.max(0, received - owedCents);
  const effectiveChange = change > 0 ? change : suggestedChange;
  const tipImplied = Math.max(0, received - owedCents - effectiveChange);
  const valid = received >= owedCents && effectiveChange >= 0 && effectiveChange <= received;

  return (
    <div className="mt-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="font-mono text-[9px] tracking-wider uppercase text-muted">
            Recibido
          </span>
          <input
            type="number"
            inputMode="numeric"
            value={received}
            onChange={(e) => setReceived(parseInt(e.target.value, 10) || 0)}
            className="mt-1 w-full h-10 px-2 rounded-lg border border-hairline bg-paper text-sm font-mono tabular focus:outline-none focus:border-[#2E6B4C]"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[9px] tracking-wider uppercase text-muted">
            Devuelta
          </span>
          <input
            type="number"
            inputMode="numeric"
            value={change}
            placeholder={String(suggestedChange)}
            onChange={(e) => setChange(parseInt(e.target.value, 10) || 0)}
            className="mt-1 w-full h-10 px-2 rounded-lg border border-hairline bg-paper text-sm font-mono tabular focus:outline-none focus:border-[#2E6B4C]"
          />
        </label>
      </div>
      <div className="text-[11px] text-ink-3">
        {tipImplied > 0
          ? `Propina implícita ${fmtCOP(tipImplied)} (recibido − cuenta − devuelta)`
          : "Sin propina."}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-10 px-4 rounded-full border border-hairline text-sm text-ink-3 disabled:opacity-50"
        >
          Volver
        </button>
        <button
          type="button"
          onClick={() => onConfirm(received, effectiveChange)}
          disabled={busy || !valid}
          className="flex-1 h-10 rounded-full bg-[#2E6B4C] text-bone text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Confirmando…" : "Confirmar"}
        </button>
      </div>
    </div>
  );
}

function humanMethod(m: string): string {
  switch (m) {
    case "kushki_apple_pay":
      return "Apple Pay";
    case "kushki_card":
      return "Tarjeta";
    case "kushki_card_terminal":
      return "Tarjeta · datáfono";
    case "external_terminal":
      return "Tarjeta · datáfono propio";
    case "kushki_pse":
      return "PSE";
    case "demo_cash":
      return "Efectivo";
    case "demo_card":
      return "Tarjeta (demo)";
    case "wompi_nequi":
      return "Nequi";
    default:
      return m;
  }
}
