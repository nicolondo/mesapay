import { captureWalletTrackingContext } from "@/lib/walletTracking/context";
import type { KushkiMode } from "@/lib/platformConfig";

type MerchantChargeContext = { restaurantId: string; mode: KushkiMode; currency: string; privateKey?: string; terminalBusinessCode?: string | null };
async function capture(input: MerchantChargeContext) {
  return captureWalletTrackingContext({ kind: "merchant", restaurantId: input.restaurantId }, {
    mode: input.mode, currency: input.currency, ...(input.privateKey ? { collectionPrivateKey: input.privateKey } : {}),
    ...(input.terminalBusinessCode !== undefined ? { terminalBusinessCode: input.terminalBusinessCode } : {}),
  });
}

/** The binding is frozen before network I/O; no credential is stored on the source. */
export async function capturePaymentTrackingFields(input: MerchantChargeContext) {
  const context = await capture(input);
  return context ? { walletTrackingKey: context.trackingKey, walletTrackingMode: context.mode, walletTrackingCurrency: context.currency } : {};
}
export async function captureLinkTrackingFields(input: MerchantChargeContext) {
  const context = await capture(input);
  return context ? { walletTrackingKey: context.trackingKey, walletTrackingMode: context.mode } : {};
}
export async function captureDepositTrackingFields(input: MerchantChargeContext) {
  const context = await capture(input);
  return context ? { depositTrackingKey: context.trackingKey, depositSourceMode: context.mode, depositCurrency: context.currency } : {};
}
