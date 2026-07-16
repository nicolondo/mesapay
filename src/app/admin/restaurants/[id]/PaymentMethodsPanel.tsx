"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  PAYMENT_METHOD_CATALOG,
  type PaymentMethodSlug,
} from "@/lib/paymentMethods";

/**
 * Admin toggle panel — enables / disables specific payment methods for
 * a given restaurant. Drives what appears on the diner's checkout
 * (PayClient, PickupCheckoutSheet). Demo methods are out of scope and
 * always controlled separately by the Kushki credential gate.
 */
export function PaymentMethodsPanel({
  restaurantId,
  initialEnabled,
}: {
  restaurantId: string;
  initialEnabled: PaymentMethodSlug[];
}) {
  const t = useTranslations("opAdmin");
  const router = useRouter();
  const [enabled, setEnabled] = useState<Set<PaymentMethodSlug>>(
    new Set(initialEnabled),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const dirty =
    enabled.size !== initialEnabled.length ||
    initialEnabled.some((s) => !enabled.has(s));

  function toggle(slug: PaymentMethodSlug) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
    setMsg(null);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(
      `/api/admin/restaurants/${restaurantId}/payment-methods`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ methods: Array.from(enabled) }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "error", text: t("saveFailedShort") });
      return;
    }
    setMsg({ kind: "ok", text: t("savedOk") });
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
            {t("paymentMethodsTitle")}
          </div>
          <div className="text-sm mt-1">
            {t("paymentMethodsIntro")}
          </div>
        </div>
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted shrink-0">
          {t("paymentMethodsCount", {
            enabled: enabled.size,
            total: PAYMENT_METHOD_CATALOG.length,
          })}
        </div>
      </div>

      <ul className="mt-4 divide-y divide-op-border">
        {PAYMENT_METHOD_CATALOG.map((m) => {
          const on = enabled.has(m.slug);
          return (
            <li
              key={m.slug}
              className="py-3 flex items-start justify-between gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{m.label}</div>
                <div className="text-[12px] text-op-muted mt-0.5">
                  {m.description}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                onClick={() => toggle(m.slug)}
                className={
                  "shrink-0 relative inline-flex items-center h-7 w-12 rounded-full transition-colors " +
                  (on ? "bg-ok" : "bg-op-border")
                }
              >
                <span
                  className={
                    "absolute top-0.5 left-0.5 inline-block w-6 h-6 rounded-full bg-bone shadow transition-transform " +
                    (on ? "translate-x-5" : "translate-x-0")
                  }
                />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="text-[11px] text-op-muted">
          {t("paymentMethodsHint")}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {msg && (
            <span
              className={
                "text-xs " +
                (msg.kind === "ok" ? "text-ok" : "text-danger")
              }
            >
              {msg.text}
            </span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="mp-btn mp-btn--primary mp-btn--sm"
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
