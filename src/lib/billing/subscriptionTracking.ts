import "server-only";
import { db } from "@/lib/db";
import { getBillingCredentials, getKushkiMode } from "@/lib/platformConfig";
import { kushkiFetch } from "@/lib/payments/kushki/client";
import { captureWalletTrackingContext, resolveTrackingContext } from "@/lib/walletTracking/context";
import type { TrackingCapture } from "@/lib/walletTracking/contracts";

type Subscription = {
  restaurantId: string; subscriptionId: string; currency: string;
  walletTrackingKey: string | null; walletTrackingMode: string | null;
};
/** Legacy subscriptions predate collection bindings. An authenticated GET can
 * establish their current collection account, without charging or changing the
 * provider subscription. Never rebind an existing identity after rotation.
 * Provider response contract: Kushki Colombia, recurring charge information.
 * https://api-docs.kushkipagos.com/es/consultar-informaci%C3%B3n-del-cargo-recurrente-37771925e0
 */
export async function recurringTrackingContext(sub: Subscription): Promise<TrackingCapture | null> {
  if (sub.walletTrackingKey) {
    return sub.walletTrackingMode === "production" || sub.walletTrackingMode === "sandbox"
      ? { trackingKey: sub.walletTrackingKey, mode: sub.walletTrackingMode, currency: sub.currency }
      : null;
  }
  try {
    const [mode, credentials] = await Promise.all([getKushkiMode(), getBillingCredentials()]);
    if ((mode !== "production" && mode !== "sandbox") || !credentials.privateKey) return null;
    const tracking = await captureWalletTrackingContext({ kind: "platform" }, { mode, currency: sub.currency, collectionPrivateKey: credentials.privateKey });
    if (!tracking) return null;
    const response = await kushkiFetch<{ subscriptionId?: unknown; amount?: { currency?: unknown } }>(
      `/subscriptions/v1/card/search/${encodeURIComponent(sub.subscriptionId)}`,
      { method: "GET", mode, auth: { kind: "billing", privateKey: credentials.privateKey }, retries: 0 },
    );
    if (!response || String(response.subscriptionId ?? "") !== sub.subscriptionId || response.amount?.currency !== sub.currency) return null;
    if ((await resolveTrackingContext({ kind: "platform" })).trackingKey !== tracking.trackingKey) return null;
    const saved = await db.billingSubscription.updateMany({
      where: { restaurantId: sub.restaurantId, kushkiSubscriptionId: sub.subscriptionId, walletTrackingKey: null },
      data: { walletTrackingKey: tracking.trackingKey, walletTrackingMode: tracking.mode },
    });
    if (saved.count) return tracking;
    const current = await db.billingSubscription.findUnique({ where: { restaurantId: sub.restaurantId },
      select: { kushkiSubscriptionId: true, walletTrackingKey: true, walletTrackingMode: true } });
    return current?.kushkiSubscriptionId === sub.subscriptionId && current.walletTrackingKey === tracking.trackingKey && current.walletTrackingMode === tracking.mode ? tracking : null;
  } catch {
    // Tracking must never interrupt the existing billing flow. The unbound
    // collection is exposed by tracking's excluded-source warning for review.
    return null;
  }
}
