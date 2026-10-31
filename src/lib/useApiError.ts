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
    // Un datáfono Kushki sólo llega acá si YA se envió al equipo (sin enviar
    // es una solicitud y el cobro la reemplaza): el mensaje dice eso y cómo
    // resolverlo si el equipo no responde.
    if (code === PENDING_PAYMENT_IN_FLIGHT) {
      const pending = body.pending as { method?: unknown; amountCents?: unknown } | null | undefined;
      if (!pending || typeof pending.amountCents !== "number") return t("pending_payment_in_flight_generic");
      const values = { method: methodLabel(pending.method), amount: fmtCOP(pending.amountCents) };
      return pending.method === "kushki_card_terminal"
        ? t("pending_payment_in_flight_terminal", values)
        : t("pending_payment_in_flight", values);
    }
    return code && t.has(code) ? t(code) : fallback ?? t("generic");
  };
}
