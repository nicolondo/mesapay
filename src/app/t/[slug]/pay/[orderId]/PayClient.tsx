"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";

const TIP_OPTIONS = [0, 5, 8, 10, 12] as const;
const METHODS = [
  { id: "demo_card" as const, label: "Tarjeta", hint: "Débito o crédito" },
  { id: "demo_nequi" as const, label: "Nequi", hint: "Transferencia" },
  { id: "demo_cash" as const, label: "Efectivo", hint: "Pagar al mesero" },
];

type PayMode = "full" | "equal" | "mine";

type PayItem = {
  id: string;
  name: string;
  qty: number;
  priceCents: number;
  guestName: string | null;
};

export function PayClient({
  tenantSlug,
  tenantName,
  orderId,
  shortCode,
  locationLabel,
  subtotalCents,
  paidCents,
  alreadyPaid,
  items,
  serviceMode,
}: {
  tenantSlug: string;
  tenantName: string;
  orderId: string;
  shortCode: string;
  locationLabel: string;
  subtotalCents: number;
  paidCents: number;
  alreadyPaid: boolean;
  items: PayItem[];
  serviceMode: "table" | "counter";
}) {
  // Counter-mode is prepay for a single diner's order — splitting the
  // cuenta makes no sense and would let someone walk off with the food
  // half-paid. Force "Todo" and hide the mode picker.
  const isCounter = serviceMode === "counter";
  const router = useRouter();
  const [tipPct, setTipPct] = useState<number>(10);
  const [method, setMethod] = useState<typeof METHODS[number]["id"]>("demo_card");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<PayMode>("full");
  const [splitCount, setSplitCount] = useState<number>(2);

  const guestTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) {
      const key = i.guestName?.trim() || "";
      if (!key) continue;
      m.set(key, (m.get(key) ?? 0) + i.priceCents * i.qty);
    }
    return Array.from(m.entries()).map(([name, cents]) => ({ name, cents }));
  }, [items]);

  const [myGuest, setMyGuest] = useState<string>(guestTotals[0]?.name ?? "");

  const tipOnSubtotalCents = Math.round((subtotalCents * tipPct) / 100);
  const outstandingCents = subtotalCents + tipOnSubtotalCents - paidCents;

  let amountCents = 0;
  let amountSubtotal = 0;
  let amountTip = 0;
  if (mode === "full") {
    amountCents = Math.max(0, outstandingCents);
    amountSubtotal = subtotalCents - paidCents;
    amountTip = tipOnSubtotalCents;
  } else if (mode === "equal") {
    const n = Math.max(2, splitCount);
    amountSubtotal = Math.round(subtotalCents / n);
    amountTip = Math.round(tipOnSubtotalCents / n);
    amountCents = amountSubtotal + amountTip;
  } else {
    const mine = guestTotals.find((g) => g.name === myGuest);
    amountSubtotal = mine?.cents ?? 0;
    amountTip = Math.round((amountSubtotal * tipPct) / 100);
    amountCents = amountSubtotal + amountTip;
  }

  async function pay() {
    if (amountCents <= 0) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/tenant/${tenantSlug}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderId,
        method,
        amountCents,
        tipCents: mode === "full" ? tipOnSubtotalCents : amountTip,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error ?? "El pago falló. Intenta de nuevo.");
      return;
    }
    const j = (await res.json().catch(() => ({}))) as {
      paymentId?: string;
      paid?: boolean;
      pending?: boolean;
    };
    if (j.pending && j.paymentId) {
      router.push(`/t/${tenantSlug}/pay/${orderId}/cash?pid=${j.paymentId}`);
      return;
    }
    // Pass the payment id so the done page can mark the current diner's
    // contribution in the shared-bill ledger.
    const done = j.paymentId
      ? `/t/${tenantSlug}/pay/${orderId}/done?pid=${j.paymentId}`
      : `/t/${tenantSlug}/pay/${orderId}/done`;
    router.push(done);
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

  const hasGuests = guestTotals.length > 0;

  return (
    <main className="flex flex-1 flex-col max-w-lg mx-auto w-full px-5 py-8">
      <Link
        href={`/t/${tenantSlug}/order/${orderId}`}
        className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink mb-5 -ml-1"
      >
        <span aria-hidden>←</span>
        <span>Volver al pedido</span>
      </Link>
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
        {locationLabel} · {tenantName} · {shortCode}
      </div>
      <h1 className="font-display text-4xl tracking-[-0.015em] mt-1">Pagar</h1>

      {/* Split mode (hidden for counter: prepay + single-diner flow) */}
      {!isCounter && (
        <div className="mt-6">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            ¿Cómo quieres pagar?
          </div>
          <div className="grid grid-cols-3 gap-2">
            <ModeButton
              active={mode === "full"}
              label="Todo"
              hint="La cuenta completa"
              onClick={() => setMode("full")}
            />
            <ModeButton
              active={mode === "equal"}
              label="Partes iguales"
              hint="Divide por N"
              onClick={() => setMode("equal")}
            />
            <ModeButton
              active={mode === "mine"}
              label="Lo mío"
              hint="Solo lo que pedí"
              onClick={() => hasGuests && setMode("mine")}
              disabled={!hasGuests}
            />
          </div>
          {mode === "mine" && !hasGuests && (
            <div className="mt-2 text-xs text-muted-2">
              Nadie dejó su nombre en los platos — usa Partes iguales.
            </div>
          )}
        </div>
      )}

      {mode === "equal" && (
        <div className="mt-4 flex items-center justify-between bg-paper border border-hairline rounded-xl px-4 py-3">
          <div className="text-sm">Dividir entre</div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSplitCount((n) => Math.max(2, n - 1))}
              className="w-8 h-8 rounded-full border border-hairline"
            >
              −
            </button>
            <div className="font-mono w-6 text-center tabular">{splitCount}</div>
            <button
              onClick={() => setSplitCount((n) => Math.min(20, n + 1))}
              className="w-8 h-8 rounded-full border border-hairline"
            >
              +
            </button>
            <span className="text-sm text-muted ml-1">personas</span>
          </div>
        </div>
      )}

      {mode === "mine" && hasGuests && (
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            ¿Quién eres?
          </div>
          <div className="flex gap-2 flex-wrap">
            {guestTotals.map((g) => {
              const active = g.name === myGuest;
              return (
                <button
                  key={g.name}
                  onClick={() => setMyGuest(g.name)}
                  className={
                    "h-10 px-4 rounded-full text-sm border inline-flex items-center gap-2 " +
                    (active
                      ? "bg-ink text-bone border-ink"
                      : "bg-paper text-ink border-hairline")
                  }
                >
                  <span>{g.name}</span>
                  <span
                    className={
                      "font-mono tabular text-xs " +
                      (active ? "opacity-70" : "text-muted")
                    }
                  >
                    {fmtCOP(g.cents)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

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
            <span className="font-mono tabular">{fmtCOP(tipOnSubtotalCents)}</span>
          </div>
        </div>
        {paidCents > 0 && (
          <Row label="Pagado previamente" value={"− " + fmtCOP(paidCents)} muted />
        )}
        <div className="mt-4 pt-4 border-t border-hairline">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              {mode === "full"
                ? "Total a pagar"
                : mode === "equal"
                  ? `Tu parte (1 de ${splitCount})`
                  : `Lo de ${myGuest || "ti"}`}
            </span>
            <span className="font-display text-3xl">{fmtCOP(amountCents)}</span>
          </div>
          {mode !== "full" && (
            <div className="mt-1 text-xs text-muted-2">
              Incluye propina proporcional · {fmtCOP(amountSubtotal)} + {fmtCOP(amountTip)}
            </div>
          )}
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
        disabled={busy || amountCents <= 0}
        className="mt-6 h-12 rounded-full bg-terracotta text-paper font-medium disabled:opacity-60"
      >
        {busy ? "Procesando…" : `Pagar ${fmtCOP(amountCents)}`}
      </button>
      <p className="mt-3 text-xs text-muted-2 text-center">
        Modo demo: no se cobra dinero real.
      </p>
    </main>
  );
}

function ModeButton({
  active,
  label,
  hint,
  onClick,
  disabled,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        "p-3 rounded-xl border text-left transition-colors disabled:opacity-50 " +
        (active
          ? "bg-ink text-bone border-ink"
          : "bg-paper border-hairline text-ink")
      }
    >
      <div className="font-medium text-sm">{label}</div>
      <div className="text-[11px] opacity-70 mt-0.5">{hint}</div>
    </button>
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
