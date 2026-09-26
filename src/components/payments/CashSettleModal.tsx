"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { displayOrderCode } from "@/lib/orderCode";
import { MoneyInput } from "@/components/MoneyInput";
import { fmtCOP } from "@/lib/format";

/**
 * Confirmar un cobro en EFECTIVO que el comensal pidió desde su QR (pago
 * `cash` pendiente): recibido, devuelta y "que se quede con el cambio" como
 * propina, contra `POST /api/operator/payments/[id]/settle-cash`. Si el
 * mesero no tiene turno abierto (by_waiter), ofrece abrirlo y reintenta.
 *
 * Nació dentro de Salón (ServeBoard); vive acá porque la ficha de la mesa y
 * la pantalla de cobro del staff muestran la misma solicitud con la misma
 * acción ("Confirmar pago recibido").
 */

/** Lo que el modal necesita del pago pendiente. */
export type CashSettleTarget = {
  id: string;
  amountCents: number;
  // Con cuánto dijo el comensal que iba a pagar (null si no lo dijo).
  cashTenderCents: number | null;
  order: { shortCode: string; tableNumber: number };
};

export function CashSettleModal({
  pending,
  serviceMode,
  onClose,
  onDone,
}: {
  pending: CashSettleTarget;
  serviceMode: "table" | "counter";
  onClose: () => void;
  /** `paid`: el cobro cerró la cuenta (para ofrecer la factura / salir). */
  onDone: (result: { paid: boolean }) => void;
}) {
  const tr = useTranslations("serve");
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
  // El mesero intentó cobrar sin turno abierto → mostramos el bloqueo
  // con opción de abrir turno (declarando base) y reintentar el cobro.
  const [noShift, setNoShift] = useState(false);
  const [baseCop, setBaseCop] = useState("0");
  const [opening, setOpening] = useState(false);
  // El local no abrió su turno general → no se puede abrir el del mesero.
  const [localClosed, setLocalClosed] = useState(false);

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
      setErr(tr("cashInsufficient"));
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
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (j.error === "mesero_no_shift") {
        // Mesero sin turno abierto → ofrecemos abrirlo en vez de un
        // error críptico.
        setNoShift(true);
        setErr(null);
        return;
      }
      setErr(j.message ?? j.error ?? tr("cashSettleError"));
      return;
    }
    onDone({ paid: j.paid === true });
  }

  // Abre el turno personal del mesero (con base declarada) y reintenta
  // el cobro.
  async function openShiftAndRetry() {
    setOpening(true);
    setErr(null);
    const r = await fetch("/api/mesero/shift/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        openingCashCents: Math.round(Number(baseCop || 0) * 100),
      }),
    });
    setOpening(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      if (j.error === "local_shift_closed") {
        setLocalClosed(true);
        setErr(null);
        return;
      }
      if (j.error === "base_exceeds_local") {
        setErr(
          tr("cashBaseExceedsLocal", { amount: fmtCOP(j.maxCents ?? 0) }),
        );
        return;
      }
      setErr(j.message ?? j.error ?? tr("cashOpenShiftError"));
      return;
    }
    setLocalClosed(false);
    setNoShift(false);
    await submit();
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
                ? tr("orderLabel", { code: displayOrderCode(pending.order.shortCode) })
                : tr("tableWithCode", {
                    number: pending.order.tableNumber,
                    code: displayOrderCode(pending.order.shortCode),
                  })}
            </div>
            <div className="font-display text-2xl">{tr("cashModalTitle")}</div>
          </div>
          <button
            onClick={onClose}
            className="text-op-muted font-mono text-xs"
            aria-label={tr("close")}
          >
            {"✕"}
          </button>
        </div>

        <div className="rounded-xl bg-op-bg border border-op-border p-3 flex items-baseline justify-between">
          <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {tr("cashTotalToCharge")}
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
            {tr("cashPaidExact")}
          </button>
          {COMMON_BILLS_COP.map((bill) => (
            <button
              key={bill}
              type="button"
              onClick={() => setReceivedSmart(String(bill))}
              className="h-8 px-3 rounded-full bg-op-bg border border-op-border text-xs font-medium hover:border-ok"
            >
              {tr("cashReceivedBill", { bill: bill.toLocaleString("es-CO") })}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              {tr("cashReceivedLabel")}
            </span>
            <MoneyInput
              value={receivedCop}
              onChange={(raw) => setReceivedSmart(raw)}
              className="h-12 px-3 rounded-xl border border-op-border bg-op-bg font-mono text-xl tabular"
            />
          </label>
          <label className="flex flex-col">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
              {tr("cashChangeLabel")}
            </span>
            <MoneyInput
              value={changeCop}
              onChange={(raw) => setChangeCop(raw)}
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
            <span aria-hidden>{"💛 "}</span>
            {tr("cashKeepChange", { amount: fmtCOP(receivedCents - due) })}
          </button>
        )}

        <div className="rounded-xl border border-dashed border-op-border p-3 text-sm flex items-center justify-between">
          <span className="text-op-muted">
            {short ? (
              tr("cashShort")
            ) : extra > 0 ? (
              <>
                <span aria-hidden>{"💛 "}</span>
                {tr("cashTip")}
              </>
            ) : (
              tr("cashExactChange")
            )}
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
            {short
              ? fmtCOP(due - net)
              : extra > 0
                ? "+ " + fmtCOP(extra)
                : "—"}
          </span>
        </div>
        {extra > 0 && (
          <div className="text-[11px] text-op-muted">{tr("cashTipExplainer")}</div>
        )}

        {noShift ? (
          <div className="rounded-xl border border-danger/40 bg-danger/5 p-4 space-y-3">
            <div className="text-sm font-medium">{tr("cashNoShiftTitle")}</div>
            <p className="text-xs text-op-muted">{tr("cashNoShiftBody")}</p>
            <label className="block">
              <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
                {tr("cashOpenBase")}
              </span>
              <div className="flex items-center gap-2 rounded-lg border border-op-border bg-op-surface px-3 h-11 mt-1">
                <span className="text-op-muted">$</span>
                <MoneyInput
                  autoFocus
                  value={baseCop}
                  onChange={(raw) => setBaseCop(raw.replace(/\D/g, ""))}
                  placeholder="0"
                  className="flex-1 bg-transparent outline-none font-display text-lg tabular min-w-0"
                />
              </div>
            </label>
            {localClosed && (
              <div className="rounded-lg border border-[#C98A2E]/40 bg-[#C98A2E]/10 p-3 text-[13px] text-[#7F5A1F] leading-snug">
                {tr("cashLocalShiftClosed")}
              </div>
            )}
            {err && <div className="text-danger text-sm">{err}</div>}
            <button
              onClick={openShiftAndRetry}
              disabled={opening}
              className="w-full h-12 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
            >
              {opening
                ? tr("cashOpening")
                : localClosed
                  ? tr("cashRetry")
                  : tr("cashOpenShift")}
            </button>
          </div>
        ) : (
          <>
            {err && <div className="text-danger text-sm">{err}</div>}
            <button
              onClick={submit}
              disabled={busy || short}
              className="w-full h-12 rounded-full bg-ok text-bone text-sm font-medium disabled:opacity-60"
            >
              {busy ? tr("cashRegistering") : tr("cashConfirm")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
