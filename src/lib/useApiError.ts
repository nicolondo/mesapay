"use client";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import { PENDING_PAYMENT_IN_FLIGHT } from "@/lib/payments/paymentInFlight";
import { usePaymentMethodLabel } from "@/lib/usePaymentMethodLabel";

/** Never expose a provider's raw response or a server's hardcoded language. */
export function useApiError() {
  const t = useTranslations("apiErrors");
  const methodLabel = usePaymentMethodLabel();
  return (body: { error?: unknown; pending?: unknown }, fallback?: string) => {
    const code = typeof body.error === "string" ? body.error : "";
    // Un pago en línea en curso no deja cobrar: el 409 trae cuál es, y el
    // mensaje lo nombra (método y monto) para que quien cobra sepa qué esperar.
    if (code === PENDING_PAYMENT_IN_FLIGHT) {
      const pending = body.pending as { method?: unknown; amountCents?: unknown } | null | undefined;
      return pending && typeof pending.amountCents === "number"
        ? t("pending_payment_in_flight", {
            method: methodLabel(pending.method),
            amount: fmtCOP(pending.amountCents),
          })
        : t("pending_payment_in_flight_generic");
    }
    return code && t.has(code) ? t(code) : fallback ?? t("generic");
  };
}
