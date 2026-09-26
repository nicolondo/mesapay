"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import { useApiError } from "@/lib/useApiError";
import { usePaymentMethodLabel } from "@/lib/usePaymentMethodLabel";
import { isCashMethod, isReplaceablePendingMethod } from "@/lib/payments/methods";
import { CashSettleModal } from "./CashSettleModal";

/** Un pago `pending` de la cuenta, como lo necesita el aviso. */
export type PendingPaymentView = {
  id: string;
  method: string;
  /** TOTAL (comida + propina), como `Payment.amountCents`. */
  amountCents: number;
  tipCents: number;
  cashTenderCents: number | null;
  createdAt: string;
};

/**
 * Aviso de pagos pendientes de una cuenta, arriba de la ficha de la mesa y
 * de la pantalla de cobro del staff.
 *
 *   · SOLICITUD del comensal ("pidió pagar con datáfono del comercio /
 *     efectivo por $X"): con la acción directa "Confirmar pago recibido",
 *     que aprueba ESE pendiente por la misma ruta que Salón
 *     (`settle-external-terminal` / `settle-cash`). Si en cambio se cobra de
 *     otra forma, el servidor la reemplaza sola (ver staffCharge.ts).
 *   · Pago EN LÍNEA en curso (PSE, tarjeta, Smart POS): sin acción; dice que
 *     hay que esperar su resultado, que es lo que el servidor exige.
 *
 * `chargeLocked`: "solo el administrador cobra" y quien mira es un mesero —
 * ve la solicitud pero no la acción (el servidor la rebotaría igual).
 */
export function PendingPaymentNotice({
  pendings,
  order,
  serviceMode = "table",
  chargeLocked = false,
  onConfirmed,
}: {
  pendings: PendingPaymentView[];
  order: { shortCode: string; tableNumber: number };
  serviceMode?: "table" | "counter";
  chargeLocked?: boolean;
  onConfirmed: (result: { paid: boolean }) => void;
}) {
  const t = useTranslations("pendingPayment");
  const methodLabel = usePaymentMethodLabel();
  const apiError = useApiError();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<{ id: string; message: string } | null>(null);
  const [cashTarget, setCashTarget] = useState<PendingPaymentView | null>(null);

  if (pendings.length === 0) return null;
  const requests = pendings.filter((p) => isReplaceablePendingMethod(p.method));
  const inFlight = pendings.filter((p) => !isReplaceablePendingMethod(p.method));

  async function confirm(p: PendingPaymentView) {
    setErr(null);
    // Efectivo: recibido / devuelta / propina, igual que en Salón.
    if (isCashMethod(p.method)) {
      setCashTarget(p);
      return;
    }
    setBusyId(p.id);
    try {
      const res = await fetch(`/api/operator/payments/${p.id}/settle-external-terminal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr({ id: p.id, message: apiError(j, t("confirmError")) });
        return;
      }
      onConfirmed({ paid: j.paid === true });
    } catch {
      setErr({ id: p.id, message: t("confirmError") });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2" aria-live="polite">
      {requests.map((p) => {
        const tender =
          isCashMethod(p.method) && p.cashTenderCents != null && p.cashTenderCents > p.amountCents
            ? p.cashTenderCents
            : null;
        return (
          <div
            key={p.id}
            className="rounded-xl border-2 border-terracotta/60 bg-terracotta/10 p-3 space-y-2"
          >
            <div className="font-mono text-[10px] tracking-wider uppercase text-terracotta">
              {t("requestKicker")}
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{methodLabel(p.method)}</span>
              <span className="font-display text-2xl tabular leading-none">
                {fmtCOP(p.amountCents)}
              </span>
            </div>
            {p.tipCents > 0 && (
              <div className="text-[11px] text-op-muted text-right">
                {t("includesTip", { amount: fmtCOP(p.tipCents) })}
              </div>
            )}
            {tender != null && (
              <div className="text-[11px] text-op-muted text-right">
                {t("cashTender", { amount: fmtCOP(tender) })}
              </div>
            )}
            {chargeLocked ? (
              <div className="rounded-lg border border-op-border bg-op-bg px-3 py-2 text-[11px] text-op-muted text-center">
                {t("adminOnly")}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => confirm(p)}
                disabled={busyId !== null}
                className="w-full h-11 rounded-full bg-ok text-bone text-sm font-medium disabled:opacity-60"
              >
                {busyId === p.id ? t("confirming") : t("confirm")}
              </button>
            )}
            {err?.id === p.id && <div className="text-danger text-xs">{err.message}</div>}
            {!chargeLocked && (
              <p className="text-[11px] text-op-muted leading-snug">{t("replaceHint")}</p>
            )}
          </div>
        );
      })}

      {inFlight.map((p) => (
        <div key={p.id} className="rounded-xl border border-op-border bg-op-bg p-3 space-y-1">
          <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
            {t("inFlightKicker")}
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{methodLabel(p.method)}</span>
            <span className="font-display text-xl tabular leading-none">{fmtCOP(p.amountCents)}</span>
          </div>
          <p className="text-[11px] text-op-muted leading-snug">{t("inFlightBody")}</p>
        </div>
      ))}

      {cashTarget && (
        <CashSettleModal
          pending={{
            id: cashTarget.id,
            amountCents: cashTarget.amountCents,
            cashTenderCents: cashTarget.cashTenderCents,
            order,
          }}
          serviceMode={serviceMode}
          onClose={() => setCashTarget(null)}
          onDone={(result) => {
            setCashTarget(null);
            onConfirmed(result);
          }}
        />
      )}
    </div>
  );
}
