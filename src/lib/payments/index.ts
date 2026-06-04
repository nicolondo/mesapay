import { db } from "../db";
import { decrypt, encrypt } from "../crypto";
import {
  getKushkiMode,
  getKushkiModeSync,
  type KushkiMode,
} from "../platformConfig";
import { LiveKushkiProvider } from "./kushki/live";
import { MockKushkiProvider } from "./kushki/mock";
import type { PaymentProvider } from "./types";

/**
 * Single entry point for callers. Resolves which provider implementation
 * to use based on the Kushki mode. We export functions instead of a class
 * because most call sites only need one or two operations.
 *
 * El modo puede ser GLOBAL (PlatformConfig) o, preferentemente, el modo
 * EFECTIVO de un comercio (Restaurant.kushkiMode resuelto vía
 * getRestaurantKushkiMode). Pasalo como `modeOverride` para que el provider
 * —y por debajo el host de Kushki— sigan la config del comercio.
 */

// Un provider por modo. Live lleva su modo adentro (host uat/prod); mock es
// stateless. Cachear por modo evita reconstruir en cada request.
const providerCache = new Map<KushkiMode, PaymentProvider>();

function providerFor(mode: KushkiMode): PaymentProvider {
  const hit = providerCache.get(mode);
  if (hit) return hit;
  const provider: PaymentProvider =
    mode === "mock"
      ? new MockKushkiProvider()
      : new LiveKushkiProvider(mode);
  providerCache.set(mode, provider);
  return provider;
}

/**
 * Async: si no se pasa `modeOverride`, lee el modo GLOBAL desde DB
 * (warmeando el cache si está stale). Pasá el modo efectivo del comercio
 * cuando lo tengas para que las llamadas a Kushki vayan al host correcto.
 */
export async function getPaymentProvider(
  modeOverride?: KushkiMode,
): Promise<PaymentProvider> {
  const mode = modeOverride ?? (await getKushkiMode());
  return providerFor(mode);
}

/**
 * Sync: usa el modo cacheado (o el override). Sólo para paths que no pueden
 * volverse async; el caché global puede estar stale hasta 60s.
 */
export function getPaymentProviderSync(
  modeOverride?: KushkiMode,
): PaymentProvider {
  const mode = modeOverride ?? getKushkiModeSync();
  return providerFor(mode);
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
    return getKushkiModeSync() === "mock" ? "mock_private_key" : null;
  }
  // Decrypt failure in mock should also degrade to placeholder — happens if
  // the master key changed and the stored ciphertext can't be read back.
  try {
    return decrypt(r.kushkiPrivateKeyEnc);
  } catch {
    if (getKushkiModeSync() === "mock") return "mock_private_key";
    throw new Error("could not decrypt stored private key");
  }
}

/**
 * Desencripta el webhook signing secret del comercio. Devuelve null si
 * el comercio no tiene secret configurado — el caller debe fallback al
 * KUSHKI_WEBHOOK_SECRET global (env) o rechazar el webhook según política.
 */
export async function getRestaurantWebhookSecret(
  restaurantId: string,
): Promise<string | null> {
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { kushkiWebhookSecretEnc: true },
  });
  if (!r?.kushkiWebhookSecretEnc) return null;
  try {
    return decrypt(r.kushkiWebhookSecretEnc);
  } catch {
    // No degradamos a "mock_secret" porque verificar firma con un
    // secret incorrecto da false-negative — preferimos rechazar el
    // webhook y dejar el error visible.
    return null;
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
