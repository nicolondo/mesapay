import { DEPOSIT_CAPABLE_SLUGS, resolveEnabledPaymentMethods, type PaymentMethodSlug } from "@/lib/paymentMethods";

/**
 * "Pagos en línea listos": el comercio puede cobrar por Kushki desde el
 * navegador del comensal (tarjeta, PSE, Apple Pay).
 *
 * Es la misma condición que el checkout (`PayFlow.kushkiReady`) y la carta
 * de recogida usan para mostrar los botones de Kushki: sub-merchant creado
 * y onboarding en `active`. Vive acá para que el link de pago de la factura
 * manual y el checkout no se desincronicen.
 */
export type OnlinePaymentsTenant = {
  kushkiMerchantId: string | null;
  kushkiOnboardingStatus: string;
};

export function onlinePaymentsReady(tenant: OnlinePaymentsTenant): boolean {
  return !!tenant.kushkiMerchantId && tenant.kushkiOnboardingStatus === "active";
}

/**
 * Medios que un pagador REMOTO puede usar: los de Kushki en línea. Son los
 * del depósito de reserva más Bre-B (el QR se paga desde la app del banco,
 * sin nadie del comercio presente). Bre-B NO es medio de depósito de
 * reserva: por eso no está en `DEPOSIT_CAPABLE_SLUGS`.
 */
export const ONLINE_METHOD_SLUGS: PaymentMethodSlug[] = [...DEPOSIT_CAPABLE_SLUGS, "kushki_bre_b"];

/**
 * Medios en línea habilitados por el comercio (∩ con los que admite el
 * navegador se resuelve del lado del cliente).
 */
export function enabledOnlineMethods(stored: unknown): string[] {
  return resolveEnabledPaymentMethods(stored).filter((m) => ONLINE_METHOD_SLUGS.includes(m));
}
