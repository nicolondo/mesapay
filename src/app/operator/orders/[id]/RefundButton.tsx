"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";

/**
 * Botón "Devolver" al lado de un pago Kushki con tarjeta. Abre un diálogo de
 * confirmación con el monto (prellenado con lo que resta; editable para una
 * devolución parcial) y llama al endpoint del operador. Solo se renderiza para
 * pagos elegibles (el server ya filtra método/estado/rol).
 */
export function RefundButton({
  paymentId,
  remainingCents,
}: {
  paymentId: string;
  remainingCents: number;
}) {
  const t = useTranslations("opOrders");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pesos, setPesos] = useState(String(Math.round(remainingCents / 100)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const cents = (parseInt(pesos || "0", 10) || 0) * 100;
  const valid = cents > 0 && cents <= remainingCents;
  const isFull = cents === remainingCents;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/operator/payments/${paymentId}/refund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(isFull ? {} : { amountCents: cents }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.message ?? j.error ?? t("refundError"));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mp-btn mp-btn--ghost mp-btn--sm"
      >
        {t("refund")}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 md:items-center md:p-6"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="w-full space-y-4 rounded-t-3xl border border-op-border bg-op-surface p-5 md:max-w-sm md:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-op-muted">
                {t("refundLabel")}
              </div>
              <h2 className="mt-1 font-display text-2xl">{t("refundTitle")}</h2>
              <p className="mt-1 text-sm text-op-muted">{t("refundBody")}</p>
            </div>
            <label className="block">
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-op-muted">
                {t("refundAmount")}
              </div>
              <div className="flex h-11 items-center gap-2 rounded-full border border-op-border bg-op-bg px-3">
                <span className="text-op-muted">{"$"}</span>
                <input
                  inputMode="numeric"
                  value={pesos}
                  onChange={(e) => setPesos(e.target.value.replace(/[^\d]/g, ""))}
                  aria-label={t("refundAmount")}
                  className="tabular min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
                />
              </div>
              <div className="mt-1 text-[11px] text-op-muted">
                {t("refundMax", { amount: fmtCOP(remainingCents) })}
              </div>
            </label>
            {err && <div className="text-sm text-danger">{err}</div>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="mp-btn mp-btn--secondary flex-1"
              >
                {t("refundCancel")}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!valid || busy}
                className="mp-btn mp-btn--danger-solid flex-1"
              >
                {busy ? t("refunding") : t("refundConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
