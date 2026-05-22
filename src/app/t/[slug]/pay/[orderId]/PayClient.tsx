"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";

const TIP_OPTIONS = [0, 5, 8, 10, 12] as const;

type PayMode = "full" | "equal" | "mine";

type PayItem = {
  id: string;
  name: string;
  qty: number;
  priceCents: number;
  guestName: string | null;
};

type MethodKind =
  | "kushki_apple_pay"
  | "kushki_google_pay"
  | "kushki_card_terminal"
  | "demo_cash"
  | "demo_card"
  | "demo_nequi";

export function PayClient({
  tenantSlug,
  tenantName,
  orderId,
  shortCode,
  locationLabel,
  subtotalCents,
  paidCents,
  paidTipCents,
  alreadyPaid,
  items,
  serviceMode,
  kushkiReady,
  kushkiPublicKey,
  isMockMode,
}: {
  tenantSlug: string;
  tenantName: string;
  orderId: string;
  shortCode: string;
  locationLabel: string;
  subtotalCents: number;
  paidCents: number;
  paidTipCents: number;
  alreadyPaid: boolean;
  items: PayItem[];
  serviceMode: "table" | "counter";
  kushkiReady: boolean;
  kushkiPublicKey: string | null;
  isMockMode: boolean;
}) {
  // Counter-mode is prepay for a single diner's order — splitting the
  // cuenta makes no sense and would let someone walk off with the food
  // half-paid. Force "Todo" and hide the mode picker.
  const isCounter = serviceMode === "counter";
  const router = useRouter();
  const [tipPct, setTipPct] = useState<number>(10);
  const [busy, setBusy] = useState<MethodKind | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<PayMode>("full");
  const [splitCount, setSplitCount] = useState<number>(2);
  const [hasApplePay, setHasApplePay] = useState(false);
  const [hasGooglePay, setHasGooglePay] = useState(false);

  // Wallet-availability sniffing happens client-side. ApplePaySession is
  // only present on Safari/iOS. Google Pay JS is loaded by Kushki SDK; for
  // mock mode we just claim it's available so the buttons show in dev.
  useEffect(() => {
    const w = window as unknown as { ApplePaySession?: { canMakePayments?: () => boolean } };
    setHasApplePay(!!w.ApplePaySession?.canMakePayments?.());
    setHasGooglePay(true); // GP availability via Kushki SDK; assume true for now
  }, []);

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

  const paidFoodCents = Math.max(0, paidCents - paidTipCents);
  const outstandingSubtotalCents = Math.max(0, subtotalCents - paidFoodCents);

  let amountSubtotal = 0;
  if (mode === "full") {
    amountSubtotal = outstandingSubtotalCents;
  } else if (mode === "equal") {
    const n = Math.max(2, splitCount);
    amountSubtotal = Math.round(subtotalCents / n);
  } else {
    const mine = guestTotals.find((g) => g.name === myGuest);
    amountSubtotal = mine?.cents ?? 0;
  }
  const amountTip = Math.round((amountSubtotal * tipPct) / 100);
  const amountCents = amountSubtotal + amountTip;

  async function payWithKushkiToken(method: "kushki_apple_pay" | "kushki_google_pay") {
    if (amountCents <= 0) return;
    setBusy(method);
    setErr(null);
    try {
      // TODO: when Kushki credentials arrive, replace this with the JS SDK
      // tokenisation flow (Kushki.requestToken or similar). For now we ship
      // a placeholder token; the mock provider accepts anything, and the
      // live provider will reject — gating us until we wire the SDK.
      const token =
        kushkiPublicKey && !isMockMode
          ? // Live: we'd grab a real token via the SDK. Bail with a friendly error.
            ""
          : `mock-token-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!token) {
        setErr("Apple/Google Pay aún no está activado para este restaurante.");
        return;
      }

      const res = await fetch(`/api/tenant/${tenantSlug}/pay/kushki-charge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId,
          method,
          token,
          amountCents,
          tipCents: amountTip,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? "El pago falló.");
        return;
      }
      if (j.approved && j.paymentId) {
        router.push(`/t/${tenantSlug}/pay/${orderId}/done?pid=${j.paymentId}`);
      } else {
        setErr(j.message ?? "Pago rechazado. Intenta con otra tarjeta o medio.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function payWithTerminal() {
    if (amountCents <= 0) return;
    setBusy("kushki_card_terminal");
    setErr(null);
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/pay/terminal-request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId,
          amountCents: amountSubtotal,
          tipCents: amountTip,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.paymentId) {
        setErr(j.error ?? "No pudimos avisar al mesero.");
        return;
      }
      router.push(`/t/${tenantSlug}/pay/${orderId}/terminal?pid=${j.paymentId}`);
    } finally {
      setBusy(null);
    }
  }

  async function payWithCash() {
    if (amountCents <= 0) return;
    setBusy("demo_cash");
    setErr(null);
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId,
          method: "demo_cash",
          amountCents,
          tipCents: amountTip,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? "No pudimos avisar al mesero.");
        return;
      }
      if (j.pending && j.paymentId) {
        router.push(`/t/${tenantSlug}/pay/${orderId}/cash?pid=${j.paymentId}`);
      }
    } finally {
      setBusy(null);
    }
  }

  // Demo paths only show when the restaurant isn't onboarded yet and we're
  // in mock mode — keeps local dev usable without ever exposing them in prod.
  async function payDemo(method: "demo_card" | "demo_nequi") {
    if (amountCents <= 0) return;
    setBusy(method);
    setErr(null);
    try {
      const res = await fetch(`/api/tenant/${tenantSlug}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId,
          method,
          amountCents,
          tipCents: amountTip,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? "El pago falló.");
        return;
      }
      const done = j.paymentId
        ? `/t/${tenantSlug}/pay/${orderId}/done?pid=${j.paymentId}`
        : `/t/${tenantSlug}/pay/${orderId}/done`;
      router.push(done);
    } finally {
      setBusy(null);
    }
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
  const showDemoFallback = isMockMode && !kushkiReady;

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
        <Row label="Subtotal de la cuenta" value={fmtCOP(subtotalCents)} />
        {paidFoodCents > 0 && (
          <Row
            label="Ya cubierto por otros"
            value={"− " + fmtCOP(paidFoodCents)}
            muted
          />
        )}
        <Row
          label={
            mode === "full"
              ? "Tu parte"
              : mode === "equal"
                ? `Tu parte (1 de ${splitCount})`
                : `Lo de ${myGuest || "ti"}`
          }
          value={fmtCOP(amountSubtotal)}
        />
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            Propina sobre tu parte
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
            <span className="font-mono tabular">{fmtCOP(amountTip)}</span>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-hairline">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Total a pagar
            </span>
            <span className="font-display text-3xl">{fmtCOP(amountCents)}</span>
          </div>
          <div className="mt-1 text-xs text-muted-2">
            {fmtCOP(amountSubtotal)} + {fmtCOP(amountTip)} propina
          </div>
        </div>
      </div>

      {err && <div className="mt-4 text-danger text-sm">{err}</div>}

      <div className="mt-6 space-y-2">
        {kushkiReady && hasApplePay && (
          <PayButton
            kind="apple"
            disabled={busy !== null || amountCents <= 0}
            busy={busy === "kushki_apple_pay"}
            onClick={() => payWithKushkiToken("kushki_apple_pay")}
            amountCents={amountCents}
          />
        )}
        {kushkiReady && hasGooglePay && (
          <PayButton
            kind="google"
            disabled={busy !== null || amountCents <= 0}
            busy={busy === "kushki_google_pay"}
            onClick={() => payWithKushkiToken("kushki_google_pay")}
            amountCents={amountCents}
          />
        )}
        {kushkiReady && (
          <PayButton
            kind="terminal"
            disabled={busy !== null || amountCents <= 0}
            busy={busy === "kushki_card_terminal"}
            onClick={payWithTerminal}
            amountCents={amountCents}
          />
        )}
        <PayButton
          kind="cash"
          disabled={busy !== null || amountCents <= 0}
          busy={busy === "demo_cash"}
          onClick={payWithCash}
          amountCents={amountCents}
        />
        {showDemoFallback && (
          <>
            <PayButton
              kind="demo_card"
              disabled={busy !== null || amountCents <= 0}
              busy={busy === "demo_card"}
              onClick={() => payDemo("demo_card")}
              amountCents={amountCents}
            />
            <PayButton
              kind="demo_nequi"
              disabled={busy !== null || amountCents <= 0}
              busy={busy === "demo_nequi"}
              onClick={() => payDemo("demo_nequi")}
              amountCents={amountCents}
            />
            <p className="text-[11px] text-muted-2 text-center pt-1">
              Modo demo. En producción solo verás Apple/Google Pay, datáfono
              y efectivo.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function PayButton({
  kind,
  disabled,
  busy,
  onClick,
  amountCents,
}: {
  kind:
    | "apple"
    | "google"
    | "terminal"
    | "cash"
    | "demo_card"
    | "demo_nequi";
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
  amountCents: number;
}) {
  const meta = BUTTON_META[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        "w-full h-12 rounded-full font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60 " +
        meta.className
      }
    >
      <span className="text-base leading-none" aria-hidden>
        {meta.icon}
      </span>
      <span>
        {busy ? "Procesando…" : `${meta.label} · ${fmtCOP(amountCents)}`}
      </span>
    </button>
  );
}

const BUTTON_META: Record<
  "apple" | "google" | "terminal" | "cash" | "demo_card" | "demo_nequi",
  { label: string; icon: string; className: string }
> = {
  apple: {
    label: "Apple Pay",
    icon: "",
    className: "bg-ink text-bone",
  },
  google: {
    label: "Google Pay",
    icon: "G",
    className: "bg-paper text-ink border border-hairline",
  },
  terminal: {
    label: "Tarjeta con datáfono",
    icon: "💳",
    className: "bg-terracotta text-paper",
  },
  cash: {
    label: "Efectivo (llamar al mesero)",
    icon: "💵",
    className: "bg-paper text-ink border border-hairline",
  },
  demo_card: {
    label: "Demo tarjeta",
    icon: "🧪",
    className: "bg-paper text-ink border border-dashed border-hairline",
  },
  demo_nequi: {
    label: "Demo Nequi",
    icon: "🧪",
    className: "bg-paper text-ink border border-dashed border-hairline",
  },
};

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
