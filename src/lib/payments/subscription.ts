import { getKushkiMode, getKushkiModeSync, type KushkiMode } from "@/lib/platformConfig";
import { MockSubscriptionProvider } from "@/lib/payments/kushki/subscriptionMock";
import { LiveSubscriptionProvider } from "@/lib/payments/kushki/subscriptionLive";

export type CardMeta = {
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
};

export type CreateSubscriptionReq = {
  token: string;
  planName: string;
  amountCents: number;
  currency: "COP" | "MXN";
  startDateIso: string; // YYYY-MM-DD futuro
  contactDetails: { firstName: string; lastName: string; email: string };
  metadata?: Record<string, string>;
};
export type CreateSubscriptionResult = { subscriptionId: string; card: CardMeta };

export type ChargeNowReq = {
  subscriptionId: string;
  amountCents: number;
  currency: "COP" | "MXN";
  metadata?: Record<string, string>;
};
export type ChargeNowResult = {
  status: "approved" | "declined";
  transactionId: string | null;
  message?: string;
};

export interface SubscriptionProvider {
  createCardSubscription(req: CreateSubscriptionReq): Promise<CreateSubscriptionResult>;
  chargeSubscriptionNow(req: ChargeNowReq): Promise<ChargeNowResult>;
  updateSubscriptionCard(req: {
    subscriptionId: string;
    token: string;
  }): Promise<{ card: CardMeta }>;
  cancelSubscription(req: { subscriptionId: string }): Promise<{ ok: boolean }>;
  getSubscription(
    req: { subscriptionId: string },
  ): Promise<{ status: string; card: CardMeta } | null>;
}

// Cache per mode — same pattern as getPaymentProvider in src/lib/payments/index.ts.
const providerCache = new Map<KushkiMode, SubscriptionProvider>();

function providerFor(mode: KushkiMode): SubscriptionProvider {
  const hit = providerCache.get(mode);
  if (hit) return hit;
  const provider: SubscriptionProvider =
    mode === "mock" ? new MockSubscriptionProvider() : new LiveSubscriptionProvider(mode);
  providerCache.set(mode, provider);
  return provider;
}

/**
 * Async: reads the global Kushki mode (with 60s cache) and returns the
 * matching SubscriptionProvider. Pass modeOverride when you already have the
 * restaurant-level mode to avoid an extra DB read.
 */
export async function getSubscriptionProvider(
  modeOverride?: KushkiMode,
): Promise<SubscriptionProvider> {
  const mode = modeOverride ?? (await getKushkiMode());
  return providerFor(mode);
}

/**
 * Sync variant — uses the cached mode. Only for paths that cannot be async.
 */
export function getSubscriptionProviderSync(
  modeOverride?: KushkiMode,
): SubscriptionProvider {
  const mode = modeOverride ?? getKushkiModeSync();
  return providerFor(mode);
}
