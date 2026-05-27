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
  const provider: PaymentProvider =
    env.KUSHKI_MODE === "mock"
      ? new MockKushkiProvider()
      : new LiveKushkiProvider();
  cached = provider;
  return provider;
}

/**
 * Look up a restaurant's Kushki private key and decrypt it. Returns null
 * if the restaurant hasn't completed onboarding (no key on file). Caller
 * decides how to surface that — typically "the restaurant isn't ready to
 * accept payments yet".
 *
 * In KUSHKI_MODE=mock we return a placeholder when there's no real key on
 * file. The mock provider doesn't validate it, so this lets admins flip a
 * tenant to "active" without also having to set MESAPAY_SECRET_KEY just to
 * encrypt a throwaway value. Production paths still need the real key.
 */
export async function getRestaurantPrivateKey(
  restaurantId: string,
): Promise<string | null> {
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { kushkiPrivateKeyEnc: true, kushkiMerchantId: true, kushkiOnboardingStatus: true },
  });
  if (!r?.kushkiPrivateKeyEnc) {
    return env.KUSHKI_MODE === "mock" ? "mock_private_key" : null;
  }
  // Decrypt failure in mock should also degrade to placeholder — happens if
  // the master key changed and the stored ciphertext can't be read back.
  try {
    return decrypt(r.kushkiPrivateKeyEnc);
  } catch {
    if (env.KUSHKI_MODE === "mock") return "mock_private_key";
    throw new Error("could not decrypt stored private key");
  }
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
