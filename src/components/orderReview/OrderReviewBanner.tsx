"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import type { OrderReviewView } from "@/lib/orderReview";
import { orderReviewLines, reviewHasCustomerDiscount } from "@/lib/orderReviewText";

/** Hora corta («6:30 p. m.») en el idioma de quien mira. */
export function useReviewTime() {
  const locale = useLocale() as Locale;
  return (iso: string) => formatDate(iso, { locale, dateStyle: undefined, timeStyle: "short" });
}

/** Quita el descuento de la cuenta (cualquier origen). true si se pudo. */
export async function removeOrderDiscountRequest(orderId: string): Promise<boolean> {
  const res = await fetch(`/api/operator/orders/${orderId}/discount`, { method: "DELETE" });
  return res.ok;
}

/** «Mantener»: el personal revisó la cuenta y sigue siendo la misma. */
export async function ackOrderReviewRequest(orderId: string): Promise<boolean> {
  const res = await fetch(`/api/operator/orders/${orderId}/review-ack`, { method: "POST" });
  return res.ok;
}

/**
 * Aviso «Revisar» de una cuenta (src/lib/orderReviewFlags.ts) con su detalle
 * y las acciones: «Mantener» (deja constancia y el aviso desaparece) y,
 * si el descuento es de un cliente de facturación, «Quitar descuento».
 * Lo usan la ficha de la mesa y la pantalla de cobro. Sin `canAct` (el
 * datáfono, que sólo cobra) se muestra el aviso sin botones.
 */
export function OrderReviewBanner({
  orderId,
  review,
  canAct,
  onChanged,
  className = "",
}: {
  orderId: string;
  review: OrderReviewView;
  canAct: boolean;
  /** Después de una acción que cambió la cuenta (refrescar la vista). */
  onChanged: () => void;
  className?: string;
}) {
  const t = useTranslations("orderReview");
  const tOrigin = useTranslations("discountOrigin");
  const fmtTime = useReviewTime();
  const [busy, setBusy] = useState<"keep" | "remove" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lines = orderReviewLines(review, (k, v) => t(k, v), fmtTime);
  if (!lines.length) return null;

  async function keep() {
    setBusy("keep");
    setErr(null);
    try {
      if (!(await ackOrderReviewRequest(orderId))) {
        setErr(t("saveError"));
        return;
      }
      onChanged();
    } catch {
      setErr(t("saveError"));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setErr(null);
    try {
      if (!(await removeOrderDiscountRequest(orderId))) {
        setErr(tOrigin("removeError"));
        return;
      }
      onChanged();
    } catch {
      setErr(t("saveError"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      role="status"
      data-testid="order-review-banner"
      className={"rounded-xl border border-warn/50 bg-warn/15 p-3 text-op-text " + className}
    >
      <div className="font-mono text-[10px] tracking-wider uppercase text-warn mb-1">
        {t("title")}
      </div>
      {lines.map((line) => (
        <p key={line} className="text-sm leading-snug">
          {line}
        </p>
      ))}
      {canAct && (
        <div className="flex flex-wrap gap-2 mt-3">
          <button
            type="button"
            onClick={keep}
            disabled={busy !== null}
            className="h-9 px-4 rounded-full bg-ink text-bone text-xs font-medium disabled:opacity-60"
          >
            {t("keep")}
          </button>
          {reviewHasCustomerDiscount(review) && (
            <button
              type="button"
              onClick={remove}
              disabled={busy !== null}
              className="h-9 px-4 rounded-full border border-danger/40 text-danger text-xs font-medium disabled:opacity-60"
            >
              {t("removeDiscount")}
            </button>
          )}
        </div>
      )}
      {err && <p className="text-danger text-xs mt-2">{err}</p>}
    </div>
  );
}
