"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";

/**
 * Saldo a favor vigente del proveedor (notas crédito sin cruzar), en
 * centavos. null mientras carga o si no se pudo leer (no se ofrece nada).
 * `refreshKey` lo vuelve a pedir (tras aplicar).
 */
export function useSupplierCredit(supplierId: string | null | undefined, refreshKey = 0): number | null {
  const [state, setState] = useState<{ key: string; cents: number } | null>(null);
  const key = supplierId ? `${supplierId}|${refreshKey}` : "";
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    (async () => {
      try {
        const id = key.split("|")[0]!;
        const r = await fetch(`/api/operator/supplier-credit-notes/context?supplierId=${encodeURIComponent(id)}&invoices=0`, {
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = (await r.json()) as { availableCents?: number };
        if (!cancelled) setState({ key, cents: j.availableCents ?? 0 });
      } catch {
        // Sin red: no se ofrece.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);
  return key && state?.key === key ? state.cents : null;
}

/** Aplica el saldo a favor del proveedor a una factura. Devuelve lo aplicado o null si falló. */
export async function applySupplierCredit(doc: { kind: "purchase" | "expense"; id: string }): Promise<number | null> {
  try {
    const r = await fetch("/api/operator/supplier-credit-notes/apply-to-doc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { appliedCents?: number };
    return j.appliedCents ?? 0;
  } catch {
    return null;
  }
}

/**
 * Aviso de saldo a favor en una factura con saldo por pagar (detalle de la
 * compra): «El proveedor tiene $X a favor por notas crédito» con el botón
 * para aplicarlo a esta factura (hasta su saldo). No pinta nada si el
 * proveedor no tiene saldo a favor o la factura no debe nada.
 */
export function SupplierCreditOffer({
  supplierId,
  doc,
  currency,
  onApplied,
}: {
  supplierId: string;
  doc: { kind: "purchase" | "expense"; id: string; outstandingCents: number };
  currency: string;
  onApplied: (appliedCents: number) => void;
}) {
  const t = useTranslations("opSupplierCredit");
  const locale = useLocale() as Locale;
  const [refresh, setRefresh] = useState(0);
  const available = useSupplierCredit(supplierId, refresh);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  if (!available || available <= 0 || doc.outstandingCents <= 0) return null;
  const amount = Math.min(available, doc.outstandingCents);
  const money = (c: number) => formatMoney(c, { currency, locale, fractionDigits: "auto" });
  return (
    <div role="status" className="mt-2 rounded-2xl border border-[#2F6B4F]/30 bg-[#2F6B4F]/8 p-3">
      <p className="text-sm font-medium">{t("offerTitle", { amount: money(available) })}</p>
      <p className="mt-0.5 text-[12px] text-op-muted">{t("offerBody", { amount: money(amount) })}</p>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(false);
          const applied = await applySupplierCredit({ kind: doc.kind, id: doc.id });
          setBusy(false);
          if (applied == null) {
            setErr(true);
            return;
          }
          setRefresh((k) => k + 1);
          onApplied(applied);
        }}
        className="mp-btn mp-btn--primary mp-btn--sm mt-2"
      >
        {t("offerApply", { amount: money(amount) })}
      </button>
      {err && <p className="mt-1 text-xs text-danger">{t("errSave")}</p>}
    </div>
  );
}
