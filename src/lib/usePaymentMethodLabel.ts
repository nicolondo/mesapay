"use client";
import { useTranslations } from "next-intl";

/**
 * Nombre visible de un método de pago (`PaymentMethod`) en el idioma del
 * usuario, para los avisos de pagos pendientes. Un método que el catálogo no
 * conoce cae en "Otro medio de pago": nunca se muestra el código crudo.
 */
export function usePaymentMethodLabel() {
  const t = useTranslations("pendingPayment");
  return (method: unknown): string => {
    const key = typeof method === "string" && method ? `methods.${method}` : "";
    return key && t.has(key) ? t(key) : t("methods.other");
  };
}
