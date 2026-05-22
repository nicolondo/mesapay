"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

export type TableState = "free" | "occupied" | "partial" | "charging" | "paid";

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
  pendingPaymentId: string | null;
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
  // operator hitting reload.
  useEffect(() => {
    const es = new EventSource(`/api/tenant/${tenantSlug}/events`);
    let last = 0;
    const onMsg = () => {
      const now = Date.now();
      if (now - last < 600) return;
      last = now;
      startTx(() => router.refresh());
    };
    es.addEventListener("message", onMsg);
    return () => {
      es.removeEventListener("message", onMsg);
      es.close();
    };
  }, [tenantSlug, router]);

  // Stats strip at the top — quick scan of the floor.
  const stats = useMemo(() => {
    let free = 0,
      open = 0,
      paid = 0,
      outstanding = 0;
    for (const t of tables) {
      if (t.state === "free") free++;
      else if (t.state === "paid") paid++;
      else open++;
      outstanding += t.outstandingCents;
    }
    return { free, open, paid, outstanding };
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
        {tables.map((t) => (
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
  paid: "bg-ok/15 border-ok/40",
};

const STATE_LABEL: Record<TableState, string> = {
  free: "Libre",
  occupied: "Abierta",
  partial: "Pago parcial",
  charging: "Cobrando…",
  paid: "Pagada",
};

function TableTile({ t, onOpen }: { t: TableCard; onOpen: () => void }) {
  const disabled = t.state === "free";
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className={
        "text-left rounded-2xl border p-4 min-h-[140px] transition-colors disabled:cursor-default disabled:opacity-60 " +
        STATE_TINT[t.state]
      }
    >
      <div className="flex items-baseline justify-between">
        <div className="font-display text-2xl">Mesa {t.number}</div>
        <div className="font-mono text-[10px] tracking-wider uppercase opacity-80">
          {STATE_LABEL[t.state]}
        </div>
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function charge() {
    if (!table.pendingPaymentId) {
      setErr("No hay un cobro de datáfono pendiente en esta mesa.");
      return;
    }
    if (!device) {
      setErr("No hay un datáfono activo registrado para este restaurante.");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/tenant/${tenantSlug}/terminal/charge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentId: table.pendingPaymentId,
        deviceId: device.id,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "No pudimos enviar al datáfono.");
      return;
    }
    onChargedQueued();
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/70 flex items-end md:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-bone text-ink rounded-t-3xl md:rounded-3xl max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-hairline flex items-center justify-between">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
              {STATE_LABEL[table.state]}
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
              <div className="rounded-xl border border-hairline bg-paper p-4">
                <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
                  Pendiente
                </div>
                <div className="font-display text-3xl tabular">
                  {fmtCOP(table.outstandingCents)}
                </div>
                <div className="text-xs text-muted mt-1">
                  Cuenta total {fmtCOP(table.subtotalCents)} · ya pagado{" "}
                  {fmtCOP(table.paidCents)}
                </div>
              </div>

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

              {table.pendingPaymentId ? (
                <button
                  onClick={charge}
                  disabled={busy}
                  className="w-full h-12 rounded-full bg-terracotta text-bone font-medium disabled:opacity-60"
                >
                  {busy
                    ? "Enviando al datáfono…"
                    : `Cobrar ${fmtCOP(table.outstandingCents)}`}
                </button>
              ) : (
                <div className="text-xs text-muted text-center pt-2">
                  El cliente no ha pedido datáfono todavía. Cuando lo haga,
                  aparecerá el botón de cobro.
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

function humanMethod(m: string): string {
  switch (m) {
    case "kushki_apple_pay":
      return "Apple Pay";
    case "kushki_google_pay":
      return "Google Pay";
    case "kushki_card_terminal":
      return "Tarjeta · datáfono";
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
