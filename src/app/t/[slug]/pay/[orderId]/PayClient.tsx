"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { fmtCOP } from "@/lib/format";
import { ApplePayButton } from "./ApplePayButton";

// Tips suggested at checkout. $0 stays for "sin propina"; 10% is the
// implicit social default in Colombia ("propina del 10"); 15% / 20%
// cubren the "el servicio fue muy bueno" case.
const TIP_OPTIONS = [0, 5, 10, 15, 20] as const;

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
  | "kushki_card"
  | "kushki_card_terminal"
  | "kushki_pse"
  | "external_terminal"
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
  declinedFlag = false,
  operatorMode = false,
  staffHomeHref = "/operator/tables",
  staffServeHref = "/operator/serve",
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
  enabledMethods: (
    | "kushki_card_terminal"
    | "kushki_card"
    | "kushki_apple_pay"
    | "kushki_pse"
    | "external_terminal"
    | "cash"
  )[];
  // Operator's assigned Smart POS (set in /operator/settings/datafonos).
  // When operatorMode is true and this is non-null, "Cobrar con
  // datáfono" pushes the charge straight to this device instead of
  // bouncing through Salón to pick one.
  assignedDeviceId?: string | null;
  assignedDeviceLabel?: string | null;
  /** Si true, mostramos banner "Pago rechazado, elegí otro método". */
  declinedFlag?: boolean;
  // The waiter is initiating payment for a diner who didn't tap "Pedir
  // cuenta" themselves. Hides Apple Pay (needs diner's phone), shows
  // a banner, and bounces back to staffHomeHref/staffServeHref once
  // the bill is either approved or queued (instead of the diner-side
  // /done view).
  operatorMode?: boolean;
  // Post-settle destinations resueltos por el server según el rol:
  // operator/platform_admin → /operator/tables + /operator/serve.
  // mesero → /mesero/mesas + /mesero/salon (el operator layout está
  // gated y un mesero quedaría con 403).
  staffHomeHref?: string;
  staffServeHref?: string;
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
  const [pseSheetOpen, setPseSheetOpen] = useState(false);
  const [cardSheetOpen, setCardSheetOpen] = useState(false);

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

  /**
   * Apple Pay — el token real viene del SDK de Kushki vía
   * <ApplePayButton/> (que muestra el sheet nativo de Apple). Acá
   * sólo recibimos el token ya válido y lo cobramos. En mock mode
   * (sin SDK) generamos un token fake.
   */
  async function payWithApplePayToken(token: string) {
    if (amountCents <= 0) return;
    setBusy("kushki_apple_pay");
    setErr(null);
    try {
      await sendKushkiTokenCharge("kushki_apple_pay", token);
    } finally {
      setBusy(null);
    }
  }

  // Mock fallback: cuando KUSHKI_MODE=mock no hay SDK que tokenice.
  // Generamos un token fake que el mock provider acepta para que el
  // wizard de dev se pueda probar end-to-end.
  async function payWithApplePayMock() {
    const token = `mock-applepay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await payWithApplePayToken(token);
  }

  /**
   * Tarjeta de crédito/débito tipeada en MESAPAY. El CardSheet ya
   * tokenizó vía Kushki.js — acá solo mandamos el token al backend
   * para que haga el charge con la private key. Datos de la tarjeta
   * (PAN/CVV) NUNCA pasan por nuestro server, mantienen SAQ-A.
   */
  async function payWithCardToken(token: string) {
    if (amountCents <= 0) return;
    setBusy("kushki_card");
    setErr(null);
    try {
      await sendKushkiTokenCharge("kushki_card", token);
    } finally {
      setBusy(null);
    }
  }

  // Shared backend roundtrip para los dos métodos token-based
  // (Apple Pay + tarjeta directa). El backend route /pay/kushki-charge
  // ya está parametrizado por method.
  async function sendKushkiTokenCharge(
    method: "kushki_apple_pay" | "kushki_card",
    token: string,
  ) {
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
    // Log completo (incluye detail crudo de Kushki) sólo en console
    // para debug. En la UI mostramos solo el mensaje amigable.
    console.log("[kushki-charge] response", { status: res.status, body: j });
    if (!res.ok) {
      setErr(j.message ?? j.error ?? "El pago falló.");
      return;
    }
    if (j.approved && j.paymentId) {
      router.push(
        operatorMode
          ? staffServeHref
          : `/t/${tenantSlug}/pay/${orderId}/done?pid=${j.paymentId}`,
      );
    } else {
      setErr(j.message ?? "Pago rechazado. Intenta con otra tarjeta o medio.");
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
          // amountCents = TOTAL (food + tip). El backend deriva food
          // restando tipCents — si mandáramos food acá, el cap y el
          // recompute le restarían el tip de nuevo y el order quedaría
          // con "FALTA $X" igual al tip.
          amountCents,
          tipCents: amountTip,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.paymentId) {
        setErr(j.message ?? j.error ?? "No pudimos avisar al mesero.");
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
          setErr(pj.message ?? pj.error ?? "No pudimos enviar el cobro al datáfono.");
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
          ? staffServeHref
          : `/t/${tenantSlug}/pay/${orderId}/terminal?pid=${j.paymentId}`,
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * Datáfono propio del comercio — el comercio cobra con su POS
   * físico externo (Bancolombia, etc.), MESAPAY sólo registra el
   * cobro. Mismo patrón que cash: crea pending, mesero confirma
   * en Salón.
   */
  async function payWithExternalTerminal() {
    if (amountCents <= 0) return;
    setBusy("external_terminal");
    setErr(null);
    try {
      const res = await fetch(
        `/api/tenant/${tenantSlug}/pay/external-terminal-request`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orderId,
            // amountCents = TOTAL (food + tip). Ver comentario en
            // payWithTerminal sobre por qué no mandamos food acá.
            amountCents,
            tipCents: amountTip,
          }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.paymentId) {
        setErr(j.message ?? j.error ?? "No pudimos avisar al mesero.");
        return;
      }
      // Mismo destino que el flujo de terminal de Kushki: el cliente
      // ve la pantalla "esperando" hasta que el mesero confirma desde
      // Salón. Bandera external=1 para que la pantalla diga "datáfono
      // del comercio" en vez de "Smart POS".
      router.push(
        operatorMode
          ? staffServeHref
          : `/t/${tenantSlug}/pay/${orderId}/terminal?pid=${j.paymentId}&external=1`,
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * PSE — el diner elige su banco + ingresa email/doc en el sheet.
   * Pasamos el bankCode a Kushki para que abra directamente la
   * página del banco sin paso extra. Resultado final por webhook.
   */
  async function payWithPse(args: {
    bankCode: string;
    email: string;
    docType: "CC" | "CE" | "NIT" | "PA" | "TI";
    docNumber: string;
    personType: "natural" | "juridica";
    // Token y redirectUrl vienen llenos cuando el sheet ya tokenizó
    // contra Kushki.js (sandbox/prod). En mock mode el backend tokeniza.
    token?: string;
    redirectUrl?: string;
  }) {
    if (amountCents <= 0) return;
    setBusy("kushki_pse");
    setErr(null);
    try {
      const res = await fetch(
        `/api/tenant/${tenantSlug}/pay/kushki-pse-init`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orderId,
            // amountCents = TOTAL (food + tip). Ver comentario en
            // payWithTerminal sobre por qué no mandamos food acá.
            amountCents,
            tipCents: amountTip,
            bankCode: args.bankCode,
            buyer: {
              email: args.email,
              docType: args.docType,
              docNumber: args.docNumber,
              personType: args.personType,
            },
            // Forward del token/redirect si Kushki.js ya tokenizó.
            ...(args.token ? { token: args.token } : {}),
            ...(args.redirectUrl ? { redirectUrl: args.redirectUrl } : {}),
          }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.redirectUrl) {
        // Si Kushki devolvió detalle del error, lo concatenamos al
        // mensaje principal — sirve para debug rápido sin pedirle al
        // diner que copie de DevTools.
        const detail = typeof j.detail === "string" ? ` (${j.detail})` : "";
        setErr(
          (j.message ?? j.error ?? "No pudimos iniciar PSE.") + detail,
        );
        return;
      }
      // Redirigimos a Kushki PSE hosted. El cliente vuelve a
      // /pse-return cuando termina.
      window.location.href = j.redirectUrl;
    } finally {
      setBusy(null);
    }
  }

  async function payWithCash(
    cashTenderCents: number | null,
    changeGivenCents: number | null = null,
  ) {
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
          changeGivenCents: changeGivenCents ?? undefined,
          // In operator mode the mesero is the one collecting AND
          // settling — no need to bounce through Salón as a pending
          // request that the same person will then settle one click
          // later. Server validates the session role before honouring.
          settleNow: operatorMode || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.message ?? j.error ?? "No pudimos avisar al mesero.");
        return;
      }
      if (operatorMode) {
        // Bill closed (or partially paid) directly. Skip the diner
        // cash-wait screen and the Salón roundtrip.
        router.push(staffHomeHref);
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
            href={staffHomeHref}
            className="font-mono text-[10px] tracking-wider uppercase underline opacity-80"
          >
            Volver a mesas
          </Link>
        </div>
      )}
      {/* En modo mesero el banner negro ya tiene "Volver a mesas".
          El cliente que paga desde su QR sí necesita un link de
          volver al pedido — lo mostramos solo para ese caso. */}
      {!operatorMode && (
        <Link
          href={`/t/${tenantSlug}/order/${orderId}`}
          className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink mb-5 -ml-1"
        >
          <span aria-hidden>←</span>
          <span>Volver al pedido</span>
        </Link>
      )}
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
        {locationLabel} · {tenantName} · {shortCode}
      </div>
      <h1 className="font-display text-4xl tracking-[-0.015em] mt-1">
        {operatorMode ? "Cobrar" : "Pagar"}
      </h1>

      {/* Resumen del pedido — solo en modo mesero. El mesero le pasa
          el celular al cliente para que confirme que todo lo que
          ordenó está bien antes de seleccionar método de pago. Si
          algo no cuadra el cliente lo dice y el mesero vuelve a
          /mesero/salon a cancelar/ajustar. */}
      {operatorMode && items.length > 0 && (
        <section className="mt-5 rounded-2xl border border-hairline bg-paper overflow-hidden">
          <div className="bg-ivory px-4 py-2.5 border-b border-hairline">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Confirma tu pedido
            </div>
          </div>
          <ul className="divide-y divide-hairline/60">
            {items.map((i) => (
              <li
                key={i.id}
                className="flex items-baseline gap-3 px-4 py-2.5 text-sm"
              >
                <span className="font-mono tabular text-muted shrink-0 w-7">
                  {i.qty}×
                </span>
                <span className="flex-1 min-w-0">{i.name}</span>
                <span className="font-mono tabular shrink-0">
                  {fmtCOP(i.priceCents * i.qty)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-between px-4 py-2.5 bg-ivory border-t border-hairline">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Subtotal
            </span>
            <span className="font-display text-lg tabular">
              {fmtCOP(subtotalCents)}
            </span>
          </div>
          {/* No mostramos "Ya pagado" aquí — esta sección es para que
              el cliente confirme que el menú coincide con lo que pidió.
              El estado de pagos vive abajo en el breakdown del cobro,
              con la convención correcta (solo comida, sin propinas). */}
        </section>
      )}

      {/* Selector de modo de pago.
          - Cliente (no operatorMode): los 3 modos en grilla (Todo / Partes / Lo mío)
            porque es el flujo principal del checkout y todos son habituales.
          - Mesero (operatorMode): el 95% del tiempo cobra TODO. Esconder
            "Partes iguales" detrás de un link compacto evita ruido en
            mobile sin sacrificar la opción cuando un grupo dice "mitad
            y mitad". El default es Todo; al tocar el link aparecen los
            dos botones para escoger. */}
      {/* Banner de error cuando el diner viene de un cobro rechazado.
          Se descarta automáticamente cuando intenta otro método (los
          handlers limpian err en el setBusy) o cuando toca el botón
          de cerrar. Sale de la URL en la primera interacción. */}
      {declinedFlag && !err && (
        <div className="mt-4 rounded-2xl border border-danger/30 bg-danger/5 p-4 flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-danger/15 text-danger flex items-center justify-center shrink-0 font-display">
            ✕
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display text-base text-danger">
              Tu pago no fue aprobado
            </div>
            <p className="text-xs text-muted mt-1">
              Probá con otro método de abajo, o pedile al mesero que vuelva
              a pasar la tarjeta.
            </p>
          </div>
        </div>
      )}

      {!isCounter && !operatorMode && (
        <div className="mt-6">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            ¿Cómo quieres pagar?
          </div>
          <div className="grid gap-2 grid-cols-3">
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

      {!isCounter && operatorMode && (
        // Toggle único compacto. Default = Todo (la inmensa mayoría de
        // los cobros del mesero son la cuenta entera). Si el cliente
        // dice "mitad y mitad" el mesero pulsa el link y el modo
        // cambia a Partes iguales (el contador +/- aparece abajo).
        // Pulsar otra vez vuelve a Todo. Un único control en vez de
        // dos botones grandes ahorra espacio en mobile.
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setMode(mode === "full" ? "equal" : "full")}
            className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted underline"
          >
            {mode === "full"
              ? "Dividir en partes iguales"
              : "Volver a cobrar todo"}
          </button>
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
        <Row label="Tu cuenta" value={fmtCOP(subtotalCents)} />
        {paidFoodCents > 0 && (
          <>
            <Row
              label="Pagado en comida"
              value={"− " + fmtCOP(paidFoodCents)}
              muted
            />
            <Row
              label="Falta de comida"
              value={fmtCOP(outstandingSubtotalCents)}
              accent
            />
          </>
        )}
        {/* La fila "A cobrar / Tu parte" solo aporta info cuando el
            monto difiere del "Falta de comida" (i.e. modo Partes
            iguales o Lo mío). Si es modo Todo y coincide, esconderla
            evita el "$30.550 / $30.550" duplicado que confundía. */}
        {amountSubtotal !== outstandingSubtotalCents && (
          <Row
            label={
              operatorMode
                ? `A cobrar (1 de ${splitCount})`
                : mode === "equal"
                  ? `Tu parte (1 de ${splitCount})`
                  : `Lo de ${myGuest || "ti"}`
            }
            value={fmtCOP(amountSubtotal)}
            accent
          />
        )}
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
              {operatorMode ? "A cobrar ahora" : "Total a pagar"}
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
            via datáfono o efectivo. En live mode usamos el componente
            ApplePayButton que renderiza el botón nativo de Apple vía
            el SDK de Kushki. En mock mode caemos al PayButton custom
            con token fake para que el wizard se pueda probar sin
            credenciales reales. */}
        {kushkiReady &&
          !operatorMode &&
          enabledMethods.includes("kushki_apple_pay") && (
            <>
              {!isMockMode && kushkiPublicKey && (
                <ApplePayButton
                  publicKey={kushkiPublicKey}
                  amountCents={amountCents}
                  displayName={tenantName}
                  busy={busy === "kushki_apple_pay"}
                  onTokenized={payWithApplePayToken}
                />
              )}
              {(isMockMode || !kushkiPublicKey) && hasApplePay && (
                <PayButton
                  kind="apple"
                  disabled={busy !== null || amountCents <= 0}
                  busy={busy === "kushki_apple_pay"}
                  onClick={payWithApplePayMock}
                  amountCents={amountCents}
                  operatorMode={operatorMode}
                />
              )}
            </>
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
        {kushkiReady &&
          enabledMethods.includes("kushki_card") &&
          !operatorMode && (
            <PayButton
              kind="card"
              disabled={busy !== null || amountCents <= 0}
              busy={busy === "kushki_card"}
              onClick={() => setCardSheetOpen(true)}
              amountCents={amountCents}
              operatorMode={operatorMode}
            />
          )}
        {enabledMethods.includes("external_terminal") && (
          <PayButton
            kind="external_terminal"
            disabled={busy !== null || amountCents <= 0}
            busy={busy === "external_terminal"}
            onClick={payWithExternalTerminal}
            amountCents={amountCents}
            operatorMode={operatorMode}
          />
        )}
        {kushkiReady &&
          enabledMethods.includes("kushki_pse") &&
          !operatorMode && (
            <PayButton
              kind="pse"
              disabled={busy !== null || amountCents <= 0}
              busy={busy === "kushki_pse"}
              onClick={() => setPseSheetOpen(true)}
              amountCents={amountCents}
              operatorMode={operatorMode}
            />
          )}
        {enabledMethods.includes("cash") && (
          <PayButton
            kind="cash"
            disabled={busy !== null || amountCents <= 0}
            busy={busy === "demo_cash"}
            // Both diner + operator open a sheet first. Diner sheet:
            // "¿con cuánto vas a pagar?" so the mesero brings the
            // right change. Operator sheet: tender + vuelto + keep-
            // the-change tip captured in one go so we settle in a
            // single click.
            onClick={() => setCashTenderOpen(true)}
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

      {cashTenderOpen && !operatorMode && (
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
      {cashTenderOpen && operatorMode && (
        <OperatorCashSheet
          amountCents={amountCents}
          busy={busy === "demo_cash"}
          onClose={() => setCashTenderOpen(false)}
          onConfirm={({ tenderCents, changeGivenCents }) => {
            setCashTenderOpen(false);
            payWithCash(tenderCents, changeGivenCents);
          }}
        />
      )}
      {pseSheetOpen && (
        <PseSheet
          tenantSlug={tenantSlug}
          amountCents={amountCents}
          busy={busy === "kushki_pse"}
          kushkiPublicKey={kushkiPublicKey}
          isMockMode={isMockMode}
          onClose={() => setPseSheetOpen(false)}
          onPay={(args) => {
            setPseSheetOpen(false);
            payWithPse(args);
          }}
        />
      )}
      {cardSheetOpen && (
        <CardSheet
          amountCents={amountCents}
          tipCents={amountTip}
          tenantSlug={tenantSlug}
          orderId={orderId}
          busy={busy === "kushki_card"}
          kushkiPublicKey={kushkiPublicKey}
          isMockMode={isMockMode}
          onClose={() => setCardSheetOpen(false)}
          onTokenized={(token) => {
            setCardSheetOpen(false);
            payWithCardToken(token);
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

/**
 * Operator-side cash collection sheet. Different shape than the diner
 * one: the mesero already has the cash in hand and is closing the
 * round right now, so we collect tender + change + keep-the-change
 * tip in a single confirmation. The diner-facing sheet stays focused
 * on "tell the waiter how much you'll pay so they bring the right
 * change."
 */
/**
 * Sheet del flow PSE. En sandbox/producción usa Kushki.js para
 * tokenizar en el browser — el SDK maneja Sift Science (anti-fraud)
 * y devuelve `security.acsURL` que es la URL real del banco. En mock
 * mode usa nuestro endpoint backend que simula el flow.
 *
 * Estructura del flow:
 *   1. requestBankList(callback) → lista de bancos via Kushki API
 *   2. user selecciona banco + ingresa email + doc
 *   3. requestTransferToken(body, callback) → token + acsURL
 *   4. POST a /kushki-pse-init para registrar el Payment
 *   5. window.location = redirectUrl (página del banco real)
 */
function PseSheet({
  tenantSlug,
  amountCents,
  busy,
  kushkiPublicKey,
  isMockMode,
  onClose,
  onPay,
}: {
  tenantSlug: string;
  amountCents: number;
  busy: boolean;
  kushkiPublicKey: string | null;
  isMockMode: boolean;
  onClose: () => void;
  // En mock mode el sheet llama a onPay con buyer data → backend tokeniza.
  // En live mode el sheet tokeniza solo y llama a onPay con el token ya
  // listo + el redirectUrl para que el caller cree el Payment.
  onPay: (args: {
    bankCode: string;
    email: string;
    docType: "CC" | "CE" | "NIT" | "PA" | "TI";
    docNumber: string;
    personType: "natural" | "juridica";
    token?: string;
    redirectUrl?: string;
  }) => void;
}) {
  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [banksLoading, setBanksLoading] = useState(true);
  const [bankCode, setBankCode] = useState("");
  const [email, setEmail] = useState("");
  const [docType, setDocType] = useState<"CC" | "CE" | "NIT" | "PA" | "TI">(
    "CC",
  );
  const [docNumber, setDocNumber] = useState("");
  const [personType, setPersonType] = useState<"natural" | "juridica">(
    "natural",
  );
  const [err, setErr] = useState<string | null>(null);
  const [tokenizing, setTokenizing] = useState(false);
  // ref al Kushki SDK instanciado — se carga lazy al abrir el sheet.
  const kushkiRef = useRef<unknown>(null);

  // Carga la lista de bancos desde nuestro backend en ambos modos.
  // El backend tiene cache in-memory de 1h y resuelve mock vs live
  // server-side — el cliente nunca espera al SDK pesado de Kushki.
  // El SDK lo cargamos LAZY en submit() solo cuando el user le da a
  // "Ir al banco" (que es cuando el costo del bundle se justifica).
  useEffect(() => {
    let alive = true;
    (async () => {
      setBanksLoading(true);
      try {
        const res = await fetch(`/api/tenant/${tenantSlug}/pay/pse-banks`);
        const j = await res.json();
        if (alive && res.ok && Array.isArray(j.banks)) {
          setBanks(j.banks);
        } else if (alive) {
          setErr(j.message ?? "No pudimos cargar la lista de bancos.");
        }
      } catch (e) {
        console.error("[pse] bank list error", e);
        if (alive) setErr("No pudimos cargar la lista de bancos.");
      } finally {
        if (alive) setBanksLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tenantSlug, isMockMode, kushkiPublicKey]);

  async function submit() {
    if (!bankCode) {
      setErr("Elegí tu banco.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr("Email inválido.");
      return;
    }
    if (!docNumber.trim()) {
      setErr("Número de documento obligatorio.");
      return;
    }
    setErr(null);

    // Mock path: delegamos al backend (no necesita SDK).
    if (isMockMode || !kushkiPublicKey) {
      onPay({
        bankCode,
        email: email.trim().toLowerCase(),
        docType,
        docNumber: docNumber.trim(),
        personType,
      });
      return;
    }

    // Live path: tokenizamos en el browser. Cargamos el SDK LAZY acá
    // (sólo al hacer click en Pay) — antes lo cargábamos al abrir el
    // sheet y el bundle pesado generaba un "Cargando bancos..." de
    // 3-5 seg innecesario.
    setTokenizing(true);
    try {
      if (!kushkiRef.current) {
        const mod = await import("@kushki/js");
        const KushkiCtor =
          mod.Kushki ?? (mod as { default?: unknown }).default;
        if (typeof KushkiCtor !== "function") {
          throw new Error("@kushki/js no expone Kushki constructor");
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const KCtor = KushkiCtor as new (opts: {
          merchantId: string;
          inTestEnvironment: boolean;
        }) => unknown;
        kushkiRef.current = new KCtor({
          merchantId: kushkiPublicKey,
          inTestEnvironment: true, // sandbox; en producción cambia
        });
      }
      // El callbackUrl debe ser ABSOLUTO y apuntar a nuestro /pse-return.
      // El SDK no la usa internamente pero Kushki la requiere para que
      // el banco sepa adónde regresar al diner.
      const callbackUrl = `${window.location.origin}/t/${tenantSlug}/pay/${getOrderIdFromPath()}/pse-return`;

      // Mapeo de doc → schema de Kushki Colombia.
      const docTypeForKushki: "CC" | "CE" | "NIT" | "TI" | "PP" =
        docType === "PA" ? "PP" : docType;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = {
        amount: {
          subtotalIva: 0,
          subtotalIva0: amountCents / 100,
          iva: 0,
        },
        callbackUrl,
        userType: personType === "juridica" ? "1" : "0",
        documentNumber: docNumber.trim(),
        documentType: docTypeForKushki,
        email: email.trim().toLowerCase(),
        currency: "COP",
        bankId: bankCode,
      };

      const response = await new Promise<{
        token?: string;
        security?: { acsURL?: string };
        code?: string;
        message?: string;
        error?: string;
      }>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (kushkiRef.current as any).requestTransferToken(
          body,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (resp: any) => resolve(resp),
        );
      });

      console.log("[pse] kushki tokens response", response);

      if (response.code) {
        setErr(
          `${response.message ?? response.error ?? "Error de Kushki"} (${response.code})`,
        );
        return;
      }
      const token = response.token;
      if (!token) {
        setErr(
          "Kushki no devolvió un token. Probá con otro banco o método.",
        );
        return;
      }

      // El SDK Kushki para PSE Colombia v1.0 NO devuelve `acsURL` en la
      // respuesta de tokenización — solo el token. El segundo POST a
      // /transfer/v1/init (server-side, con la private key) es el que
      // devuelve la URL del banco. Le pasamos el token al backend.
      onPay({
        bankCode,
        email: email.trim().toLowerCase(),
        docType,
        docNumber: docNumber.trim(),
        personType,
        token,
      });
    } catch (e) {
      console.error("[pse] tokenize error", e);
      setErr("No pudimos tokenizar con Kushki. Probá de nuevo.");
    } finally {
      setTokenizing(false);
    }
  }

  // Helper: extraer orderId de la URL actual. PseSheet no recibe el
  // orderId como prop pero está en el path /t/[slug]/pay/[orderId].
  function getOrderIdFromPath(): string {
    const parts = window.location.pathname.split("/");
    const i = parts.indexOf("pay");
    return i >= 0 ? parts[i + 1] : "";
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center justify-center">
      <div className="bg-paper w-full md:max-w-md md:rounded-2xl rounded-t-2xl p-5 max-h-[90vh] overflow-auto">
        <div className="flex items-baseline justify-between mb-4">
          <div>
            <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              PSE · Transferencia bancaria
            </div>
            <div className="font-display text-xl">
              Pagar{" "}
              <span className="tabular">
                ${(amountCents / 100).toLocaleString("es-CO")}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm"
          >
            Cerrar
          </button>
        </div>

        <p className="text-xs text-op-muted mb-4">
          Elegí tu banco y te llevaremos directo a su pasarela para
          autorizar la transferencia.
        </p>

        <label className="block mb-3">
          <div className="text-[11px] text-op-muted mb-1">Banco</div>
          <select
            value={bankCode}
            onChange={(e) => setBankCode(e.target.value)}
            disabled={banksLoading}
            className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
          >
            <option value="">
              {banksLoading ? "Cargando bancos…" : "Elegí tu banco"}
            </option>
            {banks.map((b) => (
              <option key={b.code} value={b.code}>
                {b.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block mb-3">
          <div className="text-[11px] text-op-muted mb-1">Email</div>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@email.com"
            className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
          />
        </label>

        <div className="grid grid-cols-3 gap-3 mb-3">
          <label className="block col-span-1">
            <div className="text-[11px] text-op-muted mb-1">Tipo doc</div>
            <select
              value={docType}
              onChange={(e) =>
                setDocType(e.target.value as typeof docType)
              }
              className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
            >
              <option value="CC">CC</option>
              <option value="CE">CE</option>
              <option value="NIT">NIT</option>
              <option value="PA">PA</option>
              <option value="TI">TI</option>
            </select>
          </label>
          <label className="block col-span-2">
            <div className="text-[11px] text-op-muted mb-1">Número</div>
            <input
              inputMode="numeric"
              value={docNumber}
              onChange={(e) => setDocNumber(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-sm"
            />
          </label>
        </div>

        <label className="block mb-4">
          <div className="text-[11px] text-op-muted mb-1">Tipo de persona</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPersonType("natural")}
              className={
                "flex-1 h-10 rounded-lg border text-sm " +
                (personType === "natural"
                  ? "border-ink bg-ink text-bone"
                  : "border-hairline bg-paper text-ink")
              }
            >
              Natural
            </button>
            <button
              type="button"
              onClick={() => setPersonType("juridica")}
              className={
                "flex-1 h-10 rounded-lg border text-sm " +
                (personType === "juridica"
                  ? "border-ink bg-ink text-bone"
                  : "border-hairline bg-paper text-ink")
              }
            >
              Jurídica
            </button>
          </div>
        </label>

        {err && (
          <div className="text-xs text-danger mb-3">{err}</div>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || tokenizing || banksLoading || !bankCode}
          className="w-full h-12 rounded-full bg-ink text-bone font-medium disabled:opacity-50"
        >
          {tokenizing
            ? "Tokenizando…"
            : busy
              ? "Conectando con el banco…"
              : `Ir al banco · ${"$" + (amountCents / 100).toLocaleString("es-CO")}`}
        </button>
        <p className="text-[11px] text-op-muted text-center mt-2">
          Pago seguro vía PSE. Te abrimos la página de tu banco para
          autorizar.
        </p>
      </div>
    </div>
  );
}

function OperatorCashSheet({
  amountCents,
  busy,
  onClose,
  onConfirm,
}: {
  amountCents: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: (v: { tenderCents: number; changeGivenCents: number }) => void;
}) {
  const dueCop = Math.ceil(amountCents / 100);
  // Colombia no usa centavos físicos: si una cuenta dividida cae en
  // fracción ($33.605 ÷ 2 = $16.802,50), la matemática del vuelto
  // termina en $X.XX,5 que al redondear deja al cliente debiendo
  // 50¢. Forzamos pesos enteros adentro del sheet (techo, como el
  // display) para que el preset siempre dé un vuelto físicamente
  // correcto. El servidor recibe ese mismo cuadre — la fracción <1
  // peso queda como propina mínima por redondeo (invisible al
  // usuario, contable en el back).
  const dueCents = dueCop * 100;

  // Smart presets para los billetes que se usan en Colombia. Lógica:
  //
  //   1) Round-up al próximo múltiplo de $1k, $5k, $10k, $20k, $50k
  //      y $100k. Cubre los casos "le agrego mil para no buscar
  //      monedas" y "redondeo al billete más cercano".
  //   2) Billetes reales del país ($50k y $100k — NO existe billete
  //      de $200k en Colombia). Solo si no son absurdamente más
  //      grandes que la cuenta: cap = max(amount × 5, $100k). El
  //      max contra $100k es para que cuentas chicas ($5k) sigan
  //      ofreciendo el $100k como opción (el cliente sí puede
  //      llegar con un billete grande).
  //   3) Dedupe entre las dos fuentes, ordena ascendente, toma hasta
  //      6 chips para mantener la fila scannable.
  //
  // Ejemplo $23.320 → 24, 25, 30, 40, 50, 100 (sin $200k). ✓
  const ROUND_STEPS = [1_000, 5_000, 10_000, 20_000, 50_000, 100_000];
  const REAL_BILLS_COP = [50_000, 100_000];
  const reasonableCap = Math.max(dueCop * 5, 100_000);
  const candidates = new Set<number>();
  for (const step of ROUND_STEPS) {
    const next = Math.ceil(dueCop / step) * step;
    if (next > dueCop) candidates.add(next);
  }
  for (const bill of REAL_BILLS_COP) {
    if (bill > dueCop && bill <= reasonableCap) candidates.add(bill);
  }
  const presetsCop = Array.from(candidates)
    .sort((a, b) => a - b)
    .slice(0, 6);

  const [tenderCop, setTenderCop] = useState<string>(String(dueCop));
  const [changeCop, setChangeCop] = useState<string>("0");

  const tender = Math.round(Number(tenderCop || 0) * 100);
  const change = Math.round(Number(changeCop || 0) * 100);
  const netReceived = tender - change;
  // Todo se compara contra dueCents (pesos enteros redondeados al
  // alza) en vez de amountCents (que puede tener centavos por splits)
  // — así el preset siempre da un vuelto físico y el confirm no se
  // bloquea por diferencias invisibles al usuario.
  const extraTip = netReceived - dueCents;
  const validTender = tender >= dueCents;
  const validChange = change >= 0 && change <= tender;
  const valid = validTender && validChange && netReceived >= dueCents;

  function pickPreset(bill: number) {
    setTenderCop(String(bill));
    // Sensible default: give back exact change (no extra tip). The
    // mesero can lower the change if the diner says "keep $X" — the
    // extraTip readout below updates live.
    const exactChange = bill * 100 - dueCents;
    setChangeCop(String(Math.max(0, Math.round(exactChange / 100))));
  }

  // Estado del vuelto: tres posibles configuraciones para no ambiguar.
  //   - isRefunding  : devuelta = vuelto completo (cliente recibe todo)
  //   - isKeepingAll : devuelta = 0 (todo va a propina)
  //   - partial      : ninguna de las anteriores (cliente dijo "dame
  //                    $1000 y deja el resto") — los dos shortcuts
  //                    quedan inactivos y el mesero ajusta a mano.
  const expectedChange = Math.max(0, tender - dueCents);
  const expectedChangeCop = Math.max(0, Math.round(expectedChange / 100));
  const isRefunding =
    validTender && expectedChange > 0 && change === expectedChange;
  const isKeepingAll = validTender && expectedChange > 0 && change === 0;
  function keepAllAsTip() {
    setChangeCop("0");
  }
  function refundExactChange() {
    setChangeCop(String(expectedChangeCop));
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
              Cobrar en efectivo · {fmtCOP(dueCents)}
            </div>
            <h2 className="font-display text-2xl mt-1">Confirma el cobro</h2>
            <p className="text-xs text-muted mt-1">
              Anota cuánto te pasó el cliente. Si te dice que te
              quedes con el vuelto (todo o parte), abajo eliges qué
              hacer con él.
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

        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
            ¿Con qué te pagó?
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => {
                setTenderCop(String(dueCop));
                setChangeCop("0");
              }}
              disabled={busy}
              className={
                "h-9 px-3 rounded-full text-xs font-medium border transition-colors " +
                (tender === dueCents
                  ? "bg-ink text-bone border-ink"
                  : "bg-paper border-hairline")
              }
            >
              Cuenta exacta
            </button>
            {presetsCop.map((bill) => {
              const billCents = bill * 100;
              const active = tender === billCents;
              return (
                <button
                  key={bill}
                  type="button"
                  onClick={() => pickPreset(bill)}
                  disabled={busy}
                  className={
                    "h-9 px-3 rounded-full text-xs font-medium border tabular transition-colors " +
                    (active
                      ? "bg-ink text-bone border-ink"
                      : "bg-paper border-hairline")
                  }
                >
                  {fmtCOP(billCents)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Recibido del cliente
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={formatMiles(tenderCop)}
              onChange={(e) => {
                const clean = e.target.value.replace(/[^0-9]/g, "");
                setTenderCop(clean);
              }}
              className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-xl font-display tabular"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Devuelta dada
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={formatMiles(changeCop)}
              onChange={(e) => {
                const clean = e.target.value.replace(/[^0-9]/g, "");
                setChangeCop(clean);
              }}
              className="mt-1 w-full h-11 px-3 rounded-lg border border-hairline bg-paper text-xl font-display tabular"
            />
          </label>
        </div>

        {/* Decisión clara sobre los $X de vuelto. Tres estados:
            - isRefunding  → activo el botón "Le devuelvo"
            - isKeepingAll → activo el botón "Lo deja de propina"
            - partial      → ningún botón activo (el mesero ajustó
                             la devuelta a mano via los inputs)
            Ambos botones quedan siempre clickeables salvo el que ya
            refleja el estado actual — antes había un check al revés
            que dejaba "Devolver" atascado al pasar a "Dejar". */}
        {expectedChange > 0 && (
          <div>
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-2">
              ¿Qué hace con los {fmtCOP(expectedChange)} de vuelto?
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={refundExactChange}
                disabled={busy || isRefunding}
                aria-pressed={isRefunding}
                className={
                  "h-12 rounded-2xl text-sm font-medium border px-3 transition-colors " +
                  (isRefunding
                    ? "bg-ink text-bone border-ink"
                    : "bg-paper border-hairline text-ink hover:border-ink")
                }
              >
                <div className="leading-tight">Le devuelvo</div>
                <div className="font-mono text-[10px] opacity-80 mt-0.5">
                  el vuelto
                </div>
              </button>
              <button
                type="button"
                onClick={keepAllAsTip}
                disabled={busy || isKeepingAll}
                aria-pressed={isKeepingAll}
                className={
                  "h-12 rounded-2xl text-sm font-medium border px-3 transition-colors " +
                  (isKeepingAll
                    ? "bg-ink text-bone border-ink"
                    : "bg-paper border-hairline text-ink hover:border-ink")
                }
              >
                <div className="leading-tight">Lo deja</div>
                <div className="font-mono text-[10px] opacity-80 mt-0.5">
                  de propina
                </div>
              </button>
            </div>
          </div>
        )}

        <div
          className={
            "rounded-xl px-3 py-3 text-sm border " +
            (valid
              ? extraTip > 0
                ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                : "bg-paper border-hairline text-ink"
              : "bg-red-50 border-red-200 text-red-900")
          }
        >
          {!validTender ? (
            <span>El cliente debe pasarte al menos {fmtCOP(dueCents)}.</span>
          ) : !validChange ? (
            <span>La devuelta no puede ser mayor a lo recibido.</span>
          ) : extraTip < 0 ? (
            // La devuelta es más alta que el vuelto real → mesero pondría
            // plata de su bolsillo. Mostramos el faltante y un atajo para
            // ajustar al vuelto exacto.
            <div className="space-y-2">
              <div>
                La devuelta es{" "}
                <strong className="font-mono tabular">
                  {fmtCOP(-extraTip)}
                </strong>{" "}
                mayor de lo que corresponde. El cliente te quedó debiendo
                esa diferencia.
              </div>
              <button
                type="button"
                onClick={refundExactChange}
                className="font-mono text-[10px] tracking-wider uppercase underline"
              >
                Corregir al vuelto exacto · {fmtCOP(expectedChange)}
              </button>
            </div>
          ) : extraTip > 0 ? (
            <span>
              Propina por vuelto:{" "}
              <strong className="font-mono tabular">{fmtCOP(extraTip)}</strong>
            </span>
          ) : (
            <span>Sin propina por vuelto.</span>
          )}
        </div>

        <button
          type="button"
          onClick={() =>
            onConfirm({ tenderCents: tender, changeGivenCents: change })
          }
          disabled={busy || !valid}
          className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy
            ? "Registrando…"
            : `Confirmar cobro · ${fmtCOP(dueCents + Math.max(0, extraTip))}`}
        </button>
      </div>
    </div>
  );
}

// Tiny helper for the inputs above — renders an integer-peso string
// with es-CO thousand dots while keeping the underlying digits clean.
function formatMiles(digits: string): string {
  if (!digits) return "";
  return Number(digits).toLocaleString("es-CO");
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

/**
 * Card sheet — diner ingresa datos de tarjeta y los tokenizamos en el
 * browser con Kushki.js. El PAN/CVV NUNCA pasan por nuestro server
 * (PCI SAQ-A). Devolvemos solo el token al caller via onTokenized.
 *
 * Mock mode: si KUSHKI_MODE=mock o el tenant no tiene public key,
 * generamos un token fake para que el mock provider lo acepte (mismo
 * patrón que PseSheet).
 *
 * 3DS NOT supported aún — si el banco lo requiere, Kushki devuelve
 * security.acsURL y acá lo expondríamos como redirect. Para MVP
 * dejamos las tarjetas no-3DS y el banco rechaza el resto.
 */
function CardSheet({
  amountCents,
  tipCents,
  tenantSlug,
  orderId,
  busy,
  kushkiPublicKey,
  isMockMode,
  onClose,
  onTokenized,
}: {
  amountCents: number;
  tipCents: number;
  tenantSlug: string;
  orderId: string;
  busy: boolean;
  kushkiPublicKey: string | null;
  isMockMode: boolean;
  onClose: () => void;
  onTokenized: (token: string) => void;
}) {
  const [number, setNumber] = useState("");
  const [holderName, setHolderName] = useState("");
  const [expiry, setExpiry] = useState(""); // formato MM/YY
  const [cvv, setCvv] = useState("");
  // Kushki Colombia incluye Sift Science en el SDK y el body que arma
  // el SDK tira K001 con nuestro setup. Llamamos al endpoint directo
  // — sigue siendo SAQ-A porque el PAN solo va a kushkipagos.com.
  // Email se incluye en el body para el recibo electrónico.
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tokenizing, setTokenizing] = useState(false);

  function formatCardNumber(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 19);
    return digits.replace(/(.{4})/g, "$1 ").trim();
  }
  function formatExpiry(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 4);
    if (digits.length < 3) return digits;
    return digits.slice(0, 2) + "/" + digits.slice(2);
  }

  async function submit() {
    setErr(null);
    const digits = number.replace(/\s/g, "");
    if (digits.length < 13 || digits.length > 19) {
      setErr("Número de tarjeta inválido.");
      return;
    }
    if (!holderName.trim() || holderName.trim().length < 3) {
      setErr("Ingresá el nombre como aparece en la tarjeta.");
      return;
    }
    const expiryMatch = /^(\d{2})\/(\d{2})$/.exec(expiry);
    if (!expiryMatch) {
      setErr("Vencimiento en formato MM/YY.");
      return;
    }
    const expMonth = expiryMatch[1];
    const expYear = expiryMatch[2];
    if (Number(expMonth) < 1 || Number(expMonth) > 12) {
      setErr("Mes de vencimiento inválido.");
      return;
    }
    if (!cvv.match(/^\d{3,4}$/)) {
      setErr("CVV inválido.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErr("Email inválido — Kushki lo requiere para anti-fraude.");
      return;
    }

    // Mock path: no SDK call — el mock provider acepta cualquier token.
    if (isMockMode || !kushkiPublicKey) {
      onTokenized(
        `mock-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      return;
    }

    setTokenizing(true);
    try {
      // Bypass del SDK @kushki/js: el SDK arma un body con campos de
      // Sift Science que Kushki rechaza con K001 en este setup. El
      // endpoint directo acepta el body sin los extras y devuelve el
      // token al toque. PCI SAQ-A se mantiene porque el PAN sólo viaja
      // a api-uat.kushkipagos.com (browser → Kushki), no a MESAPAY.
      const baseUrl = "https://api-uat.kushkipagos.com"; // TODO: prod URL cuando KUSHKI_MODE=production

      // 3DS: pedimos `authValidation: "url"` para que Kushki devuelva
      // la URL del banco cuando la tarjeta lo requiera. callbackUrl
      // tiene que ser absoluta — el banco redirige al diner ahí con
      // ?success=...&token=... después del OTP.
      const callbackUrl = `${window.location.origin}/t/${tenantSlug}/pay/${orderId}/3ds-return`;
      const body = {
        card: {
          number: digits,
          name: holderName.trim(),
          expiryMonth: expMonth,
          expiryYear: expYear,
          cvv,
        },
        totalAmount: amountCents / 100,
        currency: "COP",
        isDeferred: false,
        email: email.trim().toLowerCase(),
        authValidation: "url",
        callbackUrl,
      };
      console.log("[card] tokenize body shape", {
        cardLast4: digits.slice(-4),
        totalAmount: body.totalAmount,
        currency: body.currency,
        callbackUrl,
      });
      const res = await fetch(`${baseUrl}/card/v1/tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Public-Merchant-Id": kushkiPublicKey,
        },
        body: JSON.stringify(body),
      });
      const json: {
        token?: string;
        url?: string; // 3DS challenge URL del banco
        secureService?: string;
        secureId?: string;
        code?: string;
        message?: string;
      } = await res.json().catch(() => ({}));
      console.log("[card] kushki tokens response", {
        status: res.status,
        hasToken: !!json.token,
        code: json.code,
        has3DS: !!json.url,
      });
      if (!res.ok || json.code) {
        setErr(
          `${json.message ?? "Error de Kushki"}${json.code ? ` (${json.code})` : ` (HTTP ${res.status})`}`,
        );
        return;
      }
      if (!json.token) {
        setErr("Kushki no devolvió un token. Reintentá.");
        return;
      }

      // 3DS required → stash amount+tip en localStorage y redirect
      // al banco. La página /3ds-return lo recupera para hacer el
      // charge una vez que el banco valide el OTP.
      if (json.url) {
        try {
          localStorage.setItem(
            `mesapay:3ds:${orderId}`,
            JSON.stringify({ amountCents, tipCents }),
          );
        } catch (e) {
          console.error("[card] localStorage stash failed", e);
        }
        // Hard navigation al banco — el sheet ya no va a estar visible
        // cuando el diner vuelva, así que no nos importa cleanup state.
        window.location.href = json.url;
        return;
      }

      // No 3DS → token listo para charge inmediato.
      onTokenized(json.token);
    } catch (e) {
      console.error("[card] tokenize error", e);
      setErr("No pudimos tokenizar la tarjeta. Intentá de nuevo.");
    } finally {
      setTokenizing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-ink/40"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-paper rounded-t-3xl sm:rounded-3xl p-6 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
            Tarjeta · crédito o débito
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-muted hover:text-ink"
          >
            Cerrar
          </button>
        </div>
        <div className="mt-1">
          <div className="font-display text-2xl">Pagar {fmtCOP(amountCents)}</div>
        </div>

        <div className="mt-5 space-y-3">
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Número de tarjeta
            </span>
            <input
              type="tel"
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder="1234 5678 9012 3456"
              value={number}
              onChange={(e) => setNumber(formatCardNumber(e.target.value))}
              className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 font-mono tabular text-sm focus:outline-none focus:border-ink"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Nombre en la tarjeta
            </span>
            <input
              type="text"
              autoComplete="cc-name"
              placeholder="Como aparece en la tarjeta"
              value={holderName}
              onChange={(e) => setHolderName(e.target.value)}
              className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 text-sm focus:outline-none focus:border-ink"
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
              Email
            </span>
            <input
              type="email"
              autoComplete="email"
              inputMode="email"
              placeholder="tu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 text-sm focus:outline-none focus:border-ink"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                Vencimiento
              </span>
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="cc-exp"
                placeholder="MM/YY"
                value={expiry}
                onChange={(e) => setExpiry(formatExpiry(e.target.value))}
                className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 font-mono tabular text-sm focus:outline-none focus:border-ink"
              />
            </label>
            <label className="block">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                CVV
              </span>
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="cc-csc"
                placeholder="123"
                value={cvv}
                onChange={(e) =>
                  setCvv(e.target.value.replace(/\D/g, "").slice(0, 4))
                }
                className="mt-1 w-full h-11 rounded-xl border border-hairline bg-paper px-3 font-mono tabular text-sm focus:outline-none focus:border-ink"
              />
            </label>
          </div>
        </div>

        {err && (
          <div className="mt-4 text-sm text-danger bg-danger/5 border border-danger/30 rounded-lg px-3 py-2">
            {err}
          </div>
        )}

        <button
          type="button"
          disabled={busy || tokenizing}
          onClick={submit}
          className="mt-5 w-full h-12 rounded-full bg-ink text-bone font-medium text-sm disabled:opacity-60"
        >
          {tokenizing
            ? "Validando tarjeta…"
            : busy
              ? "Procesando pago…"
              : `Pagar ${fmtCOP(amountCents)}`}
        </button>
      </div>
    </div>
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
    | "card"
    | "terminal"
    | "external_terminal"
    | "pse"
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
  "apple" | "card" | "terminal" | "external_terminal" | "pse" | "cash" | "demo_terminal",
  ButtonMeta
> = {
  apple: {
    label: "Apple Pay",
    icon: "",
    className: "bg-ink text-bone",
  },
  card: {
    label: "Tarjeta de crédito o débito",
    icon: "💳",
    className: "bg-ink text-bone",
  },
  terminal: {
    label: "Tarjeta con datáfono",
    icon: "💳",
    className: "bg-terracotta text-paper",
  },
  external_terminal: {
    label: "Tarjeta (datáfono del comercio)",
    icon: "💳",
    className: "bg-paper text-ink border border-hairline",
  },
  pse: {
    label: "PSE (transferencia bancaria)",
    icon: "🏦",
    className: "bg-paper text-ink border border-hairline",
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
  "apple" | "card" | "terminal" | "external_terminal" | "pse" | "cash" | "demo_terminal",
  ButtonMeta
> = {
  apple: BUTTON_META_DINER.apple, // never shown in op mode, kept for type safety
  card: {
    label: "Cobrar con tarjeta",
    icon: "💳",
    className: "bg-ink text-bone",
  },
  terminal: {
    label: "Cobrar con datáfono",
    icon: "💳",
    className: "bg-terracotta text-paper",
  },
  external_terminal: {
    label: "Cobrar con datáfono del comercio",
    icon: "💳",
    className: "bg-paper text-ink border border-hairline",
  },
  pse: BUTTON_META_DINER.pse, // never shown in op mode, kept for type safety
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

function Row({
  label,
  value,
  muted,
  accent,
}: {
  label: string;
  value: string;
  muted?: boolean;
  // Slight emphasis — used for the "Pendiente por cobrar" subtotal
  // so it stands out between "Ya cubierto" (muted) and the per-
  // person split below.
  accent?: boolean;
}) {
  return (
    <div
      className={
        "flex items-center justify-between " +
        (muted ? "text-muted " : "") +
        (accent ? "pt-1 mt-1 border-t border-hairline font-medium" : "")
      }
    >
      <span className="text-sm">{label}</span>
      <span className="font-mono tabular">{value}</span>
    </div>
  );
}
