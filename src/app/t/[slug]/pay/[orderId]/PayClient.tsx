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
  | "kushki_card_terminal"
  | "demo_cash";

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
  enabledMethods,
  assignedDeviceId,
  assignedDeviceLabel,
  operatorMode = false,
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
  // Per-restaurant payment method toggles. Slugs of methods the admin
  // enabled in /admin/restaurants/[id]. Buttons are filtered against
  // this list so disabled methods never render.
  enabledMethods: ("kushki_card_terminal" | "kushki_apple_pay" | "cash")[];
  // Operator's assigned Smart POS (set in /operator/settings/datafonos).
  // When operatorMode is true and this is non-null, "Cobrar con
  // datáfono" pushes the charge straight to this device instead of
  // bouncing through Salón to pick one.
  assignedDeviceId?: string | null;
  assignedDeviceLabel?: string | null;
  // The waiter is initiating payment for a diner who didn't tap "Pedir
  // cuenta" themselves. Hides Apple Pay (needs diner's phone), shows
  // a banner, and bounces back to /operator/serve once the bill is
  // either approved or queued (instead of the diner-side /done view).
  operatorMode?: boolean;
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
  const [cashTenderOpen, setCashTenderOpen] = useState(false);

  // Wallet-availability sniffing happens client-side. ApplePaySession is
  // only present on Safari/iOS.
  useEffect(() => {
    const w = window as unknown as { ApplePaySession?: { canMakePayments?: () => boolean } };
    setHasApplePay(!!w.ApplePaySession?.canMakePayments?.());
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
    // Split the OUTSTANDING amount across N people, not the original
    // subtotal. Critical: if someone already paid via Apple Pay /
    // efectivo / datáfono / "lo mío" / etc., the rest of the table
    // should split what's LEFT, not the full bill. Using subtotalCents
    // here used to overcharge by the amount already collected (one of
    // the most painful bugs operators reported — Mesa 1 owed $71k,
    // partes iguales × 2 quería cobrar $214k).
    const n = Math.max(2, splitCount);
    amountSubtotal = Math.round(outstandingSubtotalCents / n);
  } else {
    const mine = guestTotals.find((g) => g.name === myGuest);
    // Cap "por persona" by the remaining balance too — if the diner
    // already paid their portion (e.g. via Apple Pay in a previous
    // round) and the system kept their guest assignment, we don't
    // want to charge them again.
    amountSubtotal = Math.min(mine?.cents ?? 0, outstandingSubtotalCents);
  }
  // Final safety net: never let amountSubtotal exceed what's still owed.
  // Belt + suspenders against any mode-specific math going sideways.
  amountSubtotal = Math.min(amountSubtotal, outstandingSubtotalCents);
  const amountTip = Math.round((amountSubtotal * tipPct) / 100);
  const amountCents = amountSubtotal + amountTip;

  async function payWithKushkiToken(method: "kushki_apple_pay") {
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
        setErr("Apple Pay aún no está activado para este restaurante.");
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
        router.push(
          operatorMode
            ? "/operator/serve"
            : `/t/${tenantSlug}/pay/${orderId}/done?pid=${j.paymentId}`,
        );
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

      // Operator mode + tied to a specific Smart POS → fire the push
      // straight to that device. The mesero is already standing at
      // the table with the datáfono in hand; no reason to bounce them
      // through Salón to pick a device manually. The push call below
      // is async on the hardware side — the webhook flips the
      // payment to approved when the customer taps their card.
      if (operatorMode && assignedDeviceId) {
        const pushRes = await fetch(
          `/api/tenant/${tenantSlug}/terminal/charge`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              paymentId: j.paymentId,
              deviceId: assignedDeviceId,
            }),
          },
        );
        if (!pushRes.ok) {
          const pj = await pushRes.json().catch(() => ({}));
          setErr(pj.error ?? "No pudimos enviar el cobro al datáfono.");
          return;
        }
        // Land on the operator-side waiting screen instead of /salón
        // — they can stay focused on this transaction until it
        // approves or declines.
        router.push(
          `/t/${tenantSlug}/pay/${orderId}/terminal?pid=${j.paymentId}&op=1`,
        );
        return;
      }

      // Diner-side flow OR operator without an assigned device:
      // create the pending and let someone pick the device in Salón.
      router.push(
        operatorMode
          ? "/operator/serve"
          : `/t/${tenantSlug}/pay/${orderId}/terminal?pid=${j.paymentId}`,
      );
    } finally {
      setBusy(null);
    }
  }

  async function payWithCash(cashTenderCents: number | null) {
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
          cashTenderCents: cashTenderCents ?? undefined,
          // In operator mode the mesero is the one collecting AND
          // settling — no need to bounce through Salón as a pending
          // request that the same person will then settle one click
          // later. Server validates the session role before honouring.
          settleNow: operatorMode || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? "No pudimos avisar al mesero.");
        return;
      }
      if (operatorMode) {
        // Bill closed (or partially paid) directly. Skip the diner
        // cash-wait screen and the Salón roundtrip.
        router.push("/operator/tables");
        return;
      }
      if (j.pending && j.paymentId) {
        router.push(`/t/${tenantSlug}/pay/${orderId}/cash?pid=${j.paymentId}`);
      }
    } finally {
      setBusy(null);
    }
  }

  // The "Demo pedir datáfono" button reuses payWithTerminal so the demo
  // path exercises the exact same code as production. No separate demo
  // function needed.

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
      {operatorMode && (
        <div className="-mx-5 -mt-8 mb-5 bg-ink text-bone px-5 py-2 text-xs flex items-center justify-between gap-3">
          <span>
            <span className="font-mono tracking-wider uppercase opacity-70 mr-2">
              Modo mesero
            </span>
            Cobrando <strong>{locationLabel}</strong>
          </span>
          <Link
            href="/operator/tables"
            className="font-mono text-[10px] tracking-wider uppercase underline opacity-80"
          >
            Volver a mesas
          </Link>
        </div>
      )}
      <Link
        href={
          operatorMode
            ? "/operator/tables"
            : `/t/${tenantSlug}/order/${orderId}`
        }
        className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink mb-5 -ml-1"
      >
        <span aria-hidden>←</span>
        <span>{operatorMode ? "Volver a mesas" : "Volver al pedido"}</span>
      </Link>
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
        {locationLabel} · {tenantName} · {shortCode}
      </div>
      <h1 className="font-display text-4xl tracking-[-0.015em] mt-1">
        {operatorMode ? "Cobrar" : "Pagar"}
      </h1>

      {!isCounter && (
        <div className="mt-6">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            {operatorMode ? "¿Cómo paga el cliente?" : "¿Cómo quieres pagar?"}
          </div>
          {/* The "Lo mío" split mode is the diner saying "I'll cover the
              items I ordered". A waiter cobrando on behalf of the table
              has no "mine" — they're collecting the whole bill or a
              shared split. Drop the third button in op mode and switch
              to a 2-column grid so the remaining two fill the row. */}
          <div
            className={
              "grid gap-2 " +
              (operatorMode ? "grid-cols-2" : "grid-cols-3")
            }
          >
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
            {!operatorMode && (
              <ModeButton
                active={mode === "mine"}
                label="Lo mío"
                hint="Solo lo que pedí"
                onClick={() => hasGuests && setMode("mine")}
                disabled={!hasGuests}
              />
            )}
          </div>
          {mode === "mine" && !hasGuests && !operatorMode && (
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
            operatorMode
              ? mode === "full"
                ? "A cobrar"
                : `A cobrar (1 de ${splitCount})`
              : mode === "full"
                ? "Tu parte"
                : mode === "equal"
                  ? `Tu parte (1 de ${splitCount})`
                  : `Lo de ${myGuest || "ti"}`
          }
          value={fmtCOP(amountSubtotal)}
        />
        <div className="mt-4">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            {operatorMode ? "Propina" : "Propina sobre tu parte"}
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
        {/* Apple Pay requires the diner's own iPhone — the waiter can't
            tap their own watch / Touch ID for someone else's card. So
            in waiter mode we hide it entirely; the operator collects
            via datáfono or efectivo. */}
        {kushkiReady &&
          hasApplePay &&
          !operatorMode &&
          enabledMethods.includes("kushki_apple_pay") && (
            <PayButton
              kind="apple"
              disabled={busy !== null || amountCents <= 0}
              busy={busy === "kushki_apple_pay"}
              onClick={() => payWithKushkiToken("kushki_apple_pay")}
              amountCents={amountCents}
              operatorMode={operatorMode}
            />
          )}
        {kushkiReady && enabledMethods.includes("kushki_card_terminal") && (
          <PayButton
            kind="terminal"
            disabled={busy !== null || amountCents <= 0}
            busy={busy === "kushki_card_terminal"}
            onClick={payWithTerminal}
            amountCents={amountCents}
            operatorMode={operatorMode}
          />
        )}
        {enabledMethods.includes("cash") && (
          <PayButton
            kind="cash"
            disabled={busy !== null || amountCents <= 0}
            busy={busy === "demo_cash"}
            // Operator mode: skip the "¿con cuánto vas a pagar?" sheet
            // — that's a diner-side flow so the waiter knows in
            // advance what change to bring. When the mesero IS the
            // waiter (waiter mode) they already have the cash in
            // hand; just settle the payment immediately.
            onClick={
              operatorMode
                ? () => payWithCash(null)
                : () => setCashTenderOpen(true)
            }
            amountCents={amountCents}
            operatorMode={operatorMode}
          />
        )}
        {showDemoFallback && enabledMethods.includes("kushki_card_terminal") && (
          <>
            {/* Same flow as the real "Tarjeta con datáfono" button — useful
                for previewing the customer's "esperando datáfono" screen
                without having to activate pagos para el restaurante. */}
            <PayButton
              kind="demo_terminal"
              disabled={busy !== null || amountCents <= 0}
              busy={busy === "kushki_card_terminal"}
              onClick={payWithTerminal}
              operatorMode={operatorMode}
              amountCents={amountCents}
            />
            <p className="text-[11px] text-muted-2 text-center pt-1">
              {operatorMode
                ? "Modo demo. En producción cobrarás con datáfono real (activa pagos para el restaurante)."
                : "Modo demo. En producción solo verás Apple Pay (Safari), datáfono y efectivo (activa pagos para el restaurante)."}
            </p>
          </>
        )}
      </div>

      {cashTenderOpen && (
        <CashTenderSheet
          amountCents={amountCents}
          busy={busy === "demo_cash"}
          onClose={() => setCashTenderOpen(false)}
          onPay={(tender) => {
            setCashTenderOpen(false);
            payWithCash(tender);
          }}
        />
      )}
    </main>
  );
}

/**
 * Optional pre-flight before the cash request. Asks the diner "¿con cuánto
 * vas a pagar?" so the waiter brings the right change on the first trip.
 * Always lets them skip with "le digo al mesero" so it never blocks the
 * actual flow.
 */
function CashTenderSheet({
  amountCents,
  busy,
  onClose,
  onPay,
}: {
  amountCents: number;
  busy: boolean;
  onClose: () => void;
  onPay: (tenderCents: number | null) => void;
}) {
  // Smart presets. Rules:
  //  - Always offer the next multiple of 10k that strictly covers the bill
  //    (so we never suggest the exact amount as a "with change" option).
  //  - Offer real Colombian bills ($10k, $20k, $50k, $100k — there is no
  //    $200k bill) that cover the bill AND whose change is no bigger than
  //    the bill itself. Suggesting $100k for a $25k bill is fine; for
  //    a $96k bill it's silly.
  //  - Cap to 3 presets so the sheet stays scannable on a phone.
  const dueCop = Math.ceil(amountCents / 100);
  const REAL_BILLS_COP = [10000, 20000, 50000, 100000];
  const maxReasonableCop = dueCop * 2;
  const candidates = new Set<number>();
  const nextRoundCop = Math.ceil(dueCop / 10000) * 10000;
  if (nextRoundCop > dueCop && nextRoundCop <= maxReasonableCop) {
    candidates.add(nextRoundCop);
  }
  for (const bill of REAL_BILLS_COP) {
    if (bill > dueCop && bill <= maxReasonableCop) {
      candidates.add(bill);
    }
  }
  const presetsCop = Array.from(candidates)
    .sort((a, b) => a - b)
    .slice(0, 3);

  const [customCop, setCustomCop] = useState<string>("");
  const customCents = Math.round(Number(customCop || 0) * 100);
  const customValid = customCents >= amountCents;

  function tenderChange(tenderCents: number): number {
    return Math.max(0, tenderCents - amountCents);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-md bg-paper rounded-t-3xl md:rounded-3xl border border-hairline p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
              Pagar en efectivo · {fmtCOP(amountCents)}
            </div>
            <h2 className="font-display text-2xl mt-1">
              ¿Con cuánto vas a pagar?
            </h2>
            <p className="text-xs text-muted mt-1">
              Opcional. Así el mesero llega con la devuelta ya contada.
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted text-sm shrink-0"
            aria-label="Cerrar"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2">
          <PresetBill
            label="Cuenta exacta"
            tenderCents={amountCents}
            changeCents={0}
            disabled={busy}
            onClick={() => onPay(amountCents)}
            primary
          />
          {presetsCop.map((cop) => {
            const tenderCents = cop * 100;
            return (
              <PresetBill
                key={cop}
                label={`Con $${cop.toLocaleString("es-CO")}`}
                tenderCents={tenderCents}
                changeCents={tenderChange(tenderCents)}
                disabled={busy}
                onClick={() => onPay(tenderCents)}
              />
            );
          })}

          <div className="rounded-xl border border-hairline bg-paper p-3">
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted mb-1">
              Otro monto
            </div>
            <div className="flex items-stretch gap-2">
              <span className="self-center text-muted">$</span>
              <input
                type="number"
                inputMode="numeric"
                value={customCop}
                onChange={(e) => setCustomCop(e.target.value)}
                placeholder="80000"
                min={Math.ceil(amountCents / 100)}
                step={1000}
                className="flex-1 h-11 px-3 rounded-lg border border-hairline bg-ivory font-mono tabular text-base focus:outline-none focus:border-terracotta"
              />
              <button
                type="button"
                disabled={busy || !customValid}
                onClick={() => onPay(customCents)}
                className="h-11 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-50"
              >
                Usar
              </button>
            </div>
            {customCop && !customValid && (
              <div className="text-[11px] text-danger mt-1">
                Menos que la cuenta ({fmtCOP(amountCents)}).
              </div>
            )}
            {customValid && customCents > amountCents && (
              <div className="text-[11px] text-muted mt-1">
                Te traen {fmtCOP(customCents - amountCents)} de devuelta.
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => onPay(null)}
          disabled={busy}
          className="w-full h-11 rounded-full border border-hairline text-sm text-ink-3 hover:text-ink disabled:opacity-50"
        >
          {busy ? "Avisando…" : "Prefiero decirle al mesero →"}
        </button>

        <p className="text-[11px] text-muted-2 text-center">
          Si llegas a pagar con otro billete, dile al mesero cuando llegue.
        </p>
      </div>
    </div>
  );
}

function PresetBill({
  label,
  tenderCents,
  changeCents,
  disabled,
  primary,
  onClick,
}: {
  label: string;
  tenderCents: number;
  changeCents: number;
  disabled: boolean;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "w-full rounded-xl border-2 px-4 py-3 flex items-center justify-between text-left disabled:opacity-50 " +
        (primary
          ? "border-ink bg-ink text-bone"
          : "border-hairline bg-paper text-ink hover:border-ink")
      }
    >
      <div>
        <div className="font-medium text-sm">{label}</div>
        <div
          className={
            "text-[11px] mt-0.5 " + (primary ? "opacity-70" : "text-muted")
          }
        >
          {changeCents > 0
            ? `Te traen ${fmtCOP(changeCents)} de devuelta`
            : "Sin devuelta"}
        </div>
      </div>
      <div className="font-mono tabular text-base">{fmtCOP(tenderCents)}</div>
    </button>
  );
}

function PayButton({
  kind,
  disabled,
  busy,
  onClick,
  amountCents,
  operatorMode,
}: {
  kind:
    | "apple"
    | "terminal"
    | "cash"
    | "demo_terminal";
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
  amountCents: number;
  operatorMode: boolean;
}) {
  const meta = (operatorMode ? BUTTON_META_OP : BUTTON_META_DINER)[kind];
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

type ButtonMeta = { label: string; icon: string; className: string };

// Copy written for the diner — they're asking the system to do
// something on their behalf, so "llamar al mesero" / "pedir datáfono"
// frame the action correctly.
const BUTTON_META_DINER: Record<
  "apple" | "terminal" | "cash" | "demo_terminal",
  ButtonMeta
> = {
  apple: {
    label: "Apple Pay",
    icon: "",
    className: "bg-ink text-bone",
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
  demo_terminal: {
    label: "Demo pedir datáfono",
    icon: "🧪",
    className: "bg-terracotta/15 text-terracotta border border-dashed border-terracotta/40",
  },
};

// Copy written for the waiter who's the one collecting the bill.
// They aren't "calling the mesero" or "asking for the datáfono" —
// they're recording how the diner is paying right now.
const BUTTON_META_OP: Record<
  "apple" | "terminal" | "cash" | "demo_terminal",
  ButtonMeta
> = {
  apple: BUTTON_META_DINER.apple, // never shown in op mode, kept for type safety
  terminal: {
    label: "Cobrar con datáfono",
    icon: "💳",
    className: "bg-terracotta text-paper",
  },
  cash: {
    label: "Recibir en efectivo",
    icon: "💵",
    className: "bg-paper text-ink border border-hairline",
  },
  demo_terminal: {
    label: "Demo · Cobrar con datáfono",
    icon: "🧪",
    className: "bg-terracotta/15 text-terracotta border border-dashed border-terracotta/40",
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
