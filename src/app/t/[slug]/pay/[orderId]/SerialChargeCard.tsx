"use client";

// Tarjeta de AVANCE del cobro en serie (sólo staff): tras cada pago de una
// cuenta dividida dice en qué va («Pago 2 de 4 aprobado · Pagado $X · Faltan
// $Y»), y el botón primario «Cobrar siguiente» repite el MISMO método del
// pago anterior con el monto de la parte que sigue ya puesto — un toque.
// Cambiar de método es igual de fácil: los medios quedan abajo con ese mismo
// monto. Si una parte se rechazó, ofrece reintentarla tal cual (misma parte,
// mismo monto recalculado contra el saldo real).
//
// La tarjeta sólo PRESENTA: el plan y los eventos los lleva
// `useSerialCharge`; los montos llegan ya calculados de `PayClient`.

import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { usePaymentMethodLabel } from "@/lib/usePaymentMethodLabel";
import {
  serialRemainingParts,
  type SerialEvent,
  type SerialMethod,
  type SerialPlan,
} from "@/lib/payments/serialCharge";

export function SerialChargeCard({
  plan,
  event,
  paidFoodCents,
  outstandingFoodCents,
  nextAmountCents,
  currency,
  repeatMethod,
  chargeBusy,
  onChargeNext,
  onDismiss,
}: {
  plan: SerialPlan | null;
  event: SerialEvent | null;
  paidFoodCents: number;
  outstandingFoodCents: number;
  /** Lo que cobraría la parte siguiente (comida + su propina). */
  nextAmountCents: number;
  currency: string;
  /**
   * Método del pago anterior, ya validado como disponible AHORA por el
   * caller (null = sin repetición con un toque; los medios quedan abajo).
   */
  repeatMethod: SerialMethod | null;
  chargeBusy: boolean;
  onChargeNext: (method: SerialMethod) => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("pay");
  const locale = useLocale() as Locale;
  const methodLabel = usePaymentMethodLabel();
  const money = (cents: number) =>
    formatMoney(cents, { currency, locale, fractionDigits: cents % 100 ? 2 : 0 });

  const settled = outstandingFoodCents <= 0;
  const showProgress = plan !== null && plan.partsDone > 0 && !settled;
  if (!event && !showProgress) return null;

  const declined = event?.kind === "declined" ? event : null;
  const approved = event?.kind === "approved" ? event : null;
  const balance = event?.kind === "balance_changed" ? event : null;

  const title = declined
    ? declined.guest
      ? t("serial.declinedGuestTitle", { name: declined.guest })
      : t("serial.declinedTitle")
    : approved
      ? approved.guest
        ? t("serial.approvedGuestTitle", { name: approved.guest })
        : t("serial.approvedTitle", { k: approved.partIndex, n: approved.splitCount })
      : t("serial.progressTitle");

  const remaining = plan ? serialRemainingParts(plan) : 1;
  const canCharge = !settled && repeatMethod !== null && !chargeBusy && nextAmountCents > 0;

  return (
    <section
      aria-live="polite"
      className={
        "mt-5 rounded-2xl border p-4 " +
        (declined
          ? "border-danger/30 bg-danger/5"
          : "border-ok/30 bg-ok/10")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className={
              "font-display text-base " + (declined ? "text-danger" : "text-ok")
            }
          >
            {title}
          </div>
          {approved && approved.amountCents > 0 && (
            <p className="text-xs text-muted mt-0.5">
              {t("serial.approvedAmount", { amount: money(approved.amountCents) })}
            </p>
          )}
          {declined && (
            <p className="text-xs text-muted mt-0.5">{t("serial.declinedBody")}</p>
          )}
          {balance && (
            <p className="text-xs text-muted mt-0.5">
              {t("serial.balanceChanged", { amount: money(balance.amountCents) })}
            </p>
          )}
          {!settled && (
            <p className="text-sm mt-2">
              {t("serial.progressLine", {
                paid: money(paidFoodCents),
                left: money(outstandingFoodCents),
              })}
              {plan && plan.mode === "equal" && (
                <span className="text-muted">
                  {" · "}
                  {t("serial.partsLeft", { count: remaining })}
                </span>
              )}
            </p>
          )}
        </div>
        {event && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted text-sm shrink-0"
            aria-label={t("close")}
          >
            {"✕"}
          </button>
        )}
      </div>

      {canCharge && repeatMethod && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => onChargeNext(repeatMethod)}
            className="w-full min-h-[52px] rounded-2xl bg-ink text-bone text-sm font-medium disabled:opacity-50"
            data-testid="serial-charge-next"
          >
            {t(declined ? "serial.retry" : "serial.chargeNext", {
              amount: money(nextAmountCents),
            })}
          </button>
          <p className="text-[11px] text-muted-2 text-center mt-1.5">
            {t("serial.repeatMethod", { method: methodLabel(repeatMethod) })}
          </p>
        </div>
      )}
    </section>
  );
}
