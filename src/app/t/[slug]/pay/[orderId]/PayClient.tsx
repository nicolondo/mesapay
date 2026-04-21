"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { fmtCOP } from "@/lib/format";

const TIP_OPTIONS = [0, 5, 8, 10, 12] as const;
const METHODS = [
  { id: "demo_card" as const, label: "Tarjeta", hint: "Débito o crédito" },
  { id: "demo_nequi" as const, label: "Nequi", hint: "Transferencia" },
  { id: "demo_cash" as const, label: "Efectivo", hint: "Pagar al mesero" },
];

export function PayClient({
  tenantSlug,
  tenantName,
  orderId,
  shortCode,
  tableNumber,
  subtotalCents,
  paidCents,
  alreadyPaid,
}: {
  tenantSlug: string;
  tenantName: string;
  orderId: string;
  shortCode: string;
  tableNumber: number;
  subtotalCents: number;
  paidCents: number;
  alreadyPaid: boolean;
}) {
  const router = useRouter();
  const [tipPct, setTipPct] = useState<number>(10);
  const [method, setMethod] = useState<typeof METHODS[number]["id"]>("demo_card");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tipCents = Math.round((subtotalCents * tipPct) / 100);
  const totalCents = subtotalCents + tipCents - paidCents;

  async function pay() {
    if (totalCents <= 0) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/tenant/${tenantSlug}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId, method, amountCents: totalCents, tipCents }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "El pago falló. Intenta de nuevo.");
      return;
    }
    router.push(`/t/${tenantSlug}/pay/${orderId}/done`);
  }

  if (alreadyPaid) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-ok/20 text-ok mx-auto flex items-center justify-center font-display text-3xl">
            ✓
          </div>
          <h1 className="font-display text-3xl mt-4">Pagado</h1>
          <p className="text-muted mt-2">
            {tenantName} ya recibió tu pago. ¡Gracias!
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col max-w-lg mx-auto w-full px-5 py-8">
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
        Mesa {tableNumber} · {tenantName} · {shortCode}
      </div>
      <h1 className="font-display text-4xl tracking-[-0.015em] mt-1">Pagar</h1>

      <div className="mt-6 bg-paper rounded-2xl border border-hairline p-5">
        <Row label="Subtotal" value={fmtCOP(subtotalCents)} />
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            Propina
          </div>
          <div className="flex gap-2 flex-wrap">
            {TIP_OPTIONS.map((p) => (
              <button
                key={p}
                onClick={() => setTipPct(p)}
                className={
                  "h-9 px-3 rounded-full text-sm border " +
                  (tipPct === p
                    ? "bg-ink text-bone border-ink"
                    : "bg-ivory border-hairline text-ink")
                }
              >
                {p === 0 ? "Sin propina" : `${p}%`}
              </button>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-sm text-muted">
            <span>Propina {tipPct}%</span>
            <span className="font-mono tabular">{fmtCOP(tipCents)}</span>
          </div>
        </div>
        {paidCents > 0 && (
          <Row label="Pagado previamente" value={"− " + fmtCOP(paidCents)} muted />
        )}
        <div className="mt-4 pt-4 border-t border-hairline flex items-baseline justify-between">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            Total a pagar
          </span>
          <span className="font-display text-3xl">{fmtCOP(totalCents)}</span>
        </div>
      </div>

      <div className="mt-6">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
          Método
        </div>
        <div className="grid grid-cols-3 gap-2">
          {METHODS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMethod(m.id)}
              className={
                "p-3 rounded-xl border text-left transition-colors " +
                (method === m.id
                  ? "bg-ink text-bone border-ink"
                  : "bg-paper border-hairline text-ink")
              }
            >
              <div className="font-medium">{m.label}</div>
              <div className="text-[11px] opacity-70 mt-0.5">{m.hint}</div>
            </button>
          ))}
        </div>
      </div>

      {err && <div className="mt-4 text-danger text-sm">{err}</div>}

      <button
        onClick={pay}
        disabled={busy || totalCents <= 0}
        className="mt-6 h-12 rounded-full bg-terracotta text-paper font-medium disabled:opacity-60"
      >
        {busy ? "Procesando…" : `Pagar ${fmtCOP(totalCents)}`}
      </button>
      <p className="mt-3 text-xs text-muted-2 text-center">
        Modo demo: no se cobra dinero real.
      </p>
    </main>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div
      className={
        "flex items-center justify-between " + (muted ? "text-muted" : "")
      }
    >
      <span className="text-sm">{label}</span>
      <span className="font-mono tabular">{value}</span>
    </div>
  );
}
