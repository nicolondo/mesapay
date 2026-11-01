"use client";
import { useTranslations } from "next-intl";
import { fmtCOP } from "@/lib/format";
import { PENDING_PAYMENT_IN_FLIGHT } from "@/lib/payments/paymentInFlight";
import { usePaymentMethodLabel } from "@/lib/usePaymentMethodLabel";

/** Código del 422 de terminal/charge cuando Kushki no validó la solicitud. */
const TERMINAL_REQUEST_REJECTED = "terminal_request_rejected";

/**
 * Never expose a provider's raw response or a server's hardcoded language.
 * (Única excepción: el código y el mensaje de Kushki cuando rechaza la
 * solicitud del datáfono por validación, que es lo que hay que revisar.)
 */
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
    // Kushki no validó la solicitud del datáfono (4xx): no se cobró. El
    // mensaje dice qué revisar y lleva el código y el texto de Kushki, que es
    // lo que necesita quien revisa el Business-Code y el serial.
    if (code === TERMINAL_REQUEST_REJECTED) {
      const k = (body as { kushki?: { code?: unknown; message?: unknown; httpStatus?: unknown } }).kushki;
      const parts = [
        typeof k?.httpStatus === "number" ? `HTTP ${k.httpStatus}` : null,
        typeof k?.code === "string" ? k.code : null,
        typeof k?.message === "string" ? k.message.slice(0, 160) : null,
      ].filter(Boolean);
      return parts.length
        ? t("terminal_request_rejected", { detail: parts.join(" · ") })
        : t("terminal_request_rejected_generic");
    }
    return code && t.has(code) ? t(code) : fallback ?? t("generic");
  };
}
