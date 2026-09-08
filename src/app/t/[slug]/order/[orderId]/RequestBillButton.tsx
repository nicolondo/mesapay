"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * "Pedir la cuenta" del comensal — DISTINTO del timbre genérico de
 * `CallWaiterButton`, que sirve igual para pedir servilletas.
 *
 * Sólo se renderea cuando el comercio activó "solo el administrador
 * cobra": ahí el mesero ya no cobra y hace falta una señal inequívoca
 * que le llegue al administrador (aviso de pantalla completa). En el
 * resto de los comercios el flujo de pago del comensal no cambia.
 */
export function RequestBillButton({
  tenantSlug,
  orderId,
}: {
  tenantSlug: string;
  orderId: string;
}) {
  const t = useTranslations("order");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, startTx] = useTransition();

  async function request() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      navigator.vibrate?.([40, 30, 40]);
    } catch {}
    const res = await fetch(
      `/api/tenant/${tenantSlug}/orders/${orderId}/request-bill`,
      { method: "POST" },
    );
    setBusy(false);
    if (!res.ok) {
      setErr(t("errRequestBill"));
      return;
    }
    setAsked(true);
    startTx(() => router.refresh());
  }

  if (asked) {
    return (
      <div className="rounded-xl border border-terracotta/40 bg-terracotta/10 px-4 py-3">
        <div className="text-sm font-medium">{t("billOnWay")}</div>
        <div className="text-[11px] text-muted mt-0.5">{t("billOnWayHint")}</div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={request}
        disabled={busy}
        className="h-11 w-full rounded-xl bg-terracotta text-bone text-sm font-medium flex items-center justify-center active:scale-[0.99] transition-transform disabled:opacity-60"
      >
        {busy ? t("requestingBill") : t("requestBill")}
      </button>
      {err && <div className="mt-1 text-xs text-danger">{err}</div>}
    </div>
  );
}
