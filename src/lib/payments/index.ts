import { env } from "../env";
import { db } from "../db";
import { decrypt, encrypt } from "../crypto";
import { LiveKushkiProvider } from "./kushki/live";
import { MockKushkiProvider } from "./kushki/mock";
import type { PaymentProvider } from "./types";

/**
 * Single entry point for callers. Resolves which provider implementation
 * to use based on KUSHKI_MODE. We export functions instead of a class
 * because most call sites only need one or two operations.
 */

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;
  cached = env.KUSHKI_MODE === "mock" ? new MockKushkiProvider() : new LiveKushkiProvider();
  return cached;
}

/**
 * Look up a restaurant's Kushki private key and decrypt it. Returns null
 * if the restaurant hasn't completed onboarding (no key on file). Caller
 * decides how to surface that — typically "the restaurant isn't ready to
 * accept payments yet".
 */
export async function getRestaurantPrivateKey(
  restaurantId: string,
): Promise<string | null> {
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { kushkiPrivateKeyEnc: true, kushkiMerchantId: true, kushkiOnboardingStatus: true },
  });
  if (!r?.kushkiPrivateKeyEnc) return null;
  return decrypt(r.kushkiPrivateKeyEnc);
}

/**
 * Persist a sub-merchant's credentials returned by the provider after
 * onboarding. Splits into the (non-secret) merchantId/publicKey and the
 * encrypted private key.
 */
export async function saveSubmerchantCredentials(
  restaurantId: string,
  creds: { merchantId: string; publicKey: string; privateKey: string },
): Promise<void> {
  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      kushkiMerchantId: creds.merchantId,
      kushkiPublicKey: creds.publicKey,
      kushkiPrivateKeyEnc: encrypt(creds.privateKey),
      kushkiSubmittedAt: new Date(),
    },
  });
}

export * from "./types";
