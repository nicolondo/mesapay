"use client";

import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import type { OrderReviewView } from "@/lib/orderReview";
import { orderReviewLines, reviewHasCustomerDiscount } from "@/lib/orderReviewText";
import { useReviewTime } from "./OrderReviewBanner";

export type OrderReviewChoice = "keep" | "remove";

/**
 * Aviso «Revisar» ANTES de que el personal confirme una ronda nueva sobre
 * una cuenta sospechosa (src/lib/orderReviewFlags.ts, evaluada como si la
 * ronda se montara ahora). No bloquea: el personal decide.
 *
 *   - Descuento de un cliente: «Mantener y enviar» / «Quitar descuento y
 *     enviar» / «Volver».
 *   - Sólo cuenta abierta hace horas o con un cobro rechazado: «Sí, enviar
 *     el pedido» / «Volver».
 *
 * Elegir enviar deja constancia («Mantener», `Order.reviewAckAt`) para no
 * volver a preguntar por la misma señal.
 */
export function OrderReviewConfirm({
  review,
  busy,
  error,
  onChoose,
  onCancel,
}: {
  review: OrderReviewView;
  busy: boolean;
  error: string | null;
  onChoose: (choice: OrderReviewChoice) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("orderReview");
  const fmtTime = useReviewTime();
  const lines = orderReviewLines(review, (k, v) => t(k, v), fmtTime);
  const hasDiscount = reviewHasCustomerDiscount(review);
  return (
    <AppDialog
      label={t("confirmTitle")}
      onClose={onCancel}
      placement="center"
      dismissOnBackdrop={!busy}
      className="rounded-2xl bg-paper text-ink"
    >
      <div className="p-5" data-testid="order-review-confirm">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-warn">
          {t("title")}
        </div>
        <h2 className="font-display text-2xl mt-1">{t("confirmTitle")}</h2>
        <div className="mt-3 space-y-2">
          {lines.map((line) => (
            <p key={line} className="text-sm leading-snug">
              {line}
            </p>
          ))}
        </div>
        {error && <p className="text-danger text-xs mt-3">{error}</p>}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onChoose("keep")}
            className="h-11 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
          >
            {hasDiscount ? t("keepAndSend") : t("sameGroupSend")}
          </button>
          {hasDiscount && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChoose("remove")}
              className="h-11 rounded-full border border-danger/40 text-danger text-sm font-medium disabled:opacity-60"
            >
              {t("removeAndSend")}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-11 rounded-full border border-hairline text-sm disabled:opacity-60"
          >
            {t("back")}
          </button>
        </div>
      </div>
    </AppDialog>
  );
}
