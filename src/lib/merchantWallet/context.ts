import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { walletAccountFingerprint } from "@/lib/walletTracking/fingerprint";
import { WalletError } from "@/lib/platformWallet/errors";
import type { WalletCredentials } from "@/lib/platformWallet/provider";

export async function merchantWalletLock(tx: Prisma.TransactionClient, restaurantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`merchant-wallet:${restaurantId}`}))::text`;
}
export async function merchantWalletContext(restaurantId: string) {
  const r = await db.restaurant.findUnique({ where: { id: restaurantId }, select: {
    kushkiMerchantId: true, kushkiMode: true, country: true, bankInfo: true,
    kushkiPublicKey: true, kushkiPrivateKeyEnc: true, kushkiPayoutPublicKey: true, kushkiPayoutPrivateKeyEnc: true,
  } });
  if (!r?.kushkiMerchantId) throw new WalletError("not_onboarded");
  const mode = await getRestaurantKushkiMode(r);
  if (mode !== "sandbox" && mode !== "production") throw new WalletError("credentials_missing", 503);
  // Preserve the existing per-merchant Transfer Out pair/fallback policy. Read
  // both keys in one row snapshot; never fall back after a decryption failure.
  const hasPayoutPair = !!r.kushkiPayoutPublicKey && !!r.kushkiPayoutPrivateKeyEnc;
  const publicKey = hasPayoutPair ? r.kushkiPayoutPublicKey : r.kushkiPublicKey;
  const encrypted = hasPayoutPair ? r.kushkiPayoutPrivateKeyEnc : r.kushkiPrivateKeyEnc;
  if (!publicKey || !encrypted) throw new WalletError("credentials_missing", 503);
  let privateKey: string;
  try { privateKey = decrypt(encrypted); } catch { throw new WalletError("credentials_unavailable", 503); }
  if (!privateKey) throw new WalletError("credentials_missing", 503);
  const credentials: WalletCredentials = { mode, publicKey, privateKey };
  return { credentials, fingerprint: walletAccountFingerprint(credentials), currency: await getCurrencyForCountry(r.country), bankInfo: r.bankInfo };
}
