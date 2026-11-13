"use client";
import { useTranslations } from "next-intl";

/**
 * Motivo de un cobro con tarjeta / Apple Pay que no pasó → texto para quien
 * paga. Las rutas de cobro devuelven `reason` como CÓDIGO
 * (`KushkiDeclineReason` de lib/payments/kushki/declineReason.ts, o
 * `uncertain` cuando no se sabe si Kushki cobró); acá se traduce con el
 * namespace `chargeDecline`. Devuelve null si el código no se conoce, para
 * que cada pantalla use su mensaje genérico. Nunca muestra texto del
 * proveedor ni del servidor.
 */
export function useChargeDeclineText() {
  const t = useTranslations("chargeDecline");
  return (reason: unknown): string | null => {
    // El código puede venir de la URL (vuelta del 3DS): sólo claves válidas.
    if (typeof reason !== "string" || !/^[a-z_]{1,40}$/.test(reason)) return null;
    return t.has(reason) ? t(reason) : null;
  };
}
