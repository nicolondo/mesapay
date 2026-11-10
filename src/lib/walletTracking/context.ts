import "server-only";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getBillingCredentials, getKushkiMode, getRestaurantKushkiMode } from "@/lib/platformConfig";
import { getRestaurantPayoutCredentials } from "@/lib/payments";
import { env } from "@/lib/env";
import type { TrackingScope, TrackingMode, TrackingCapture } from "./contracts";
import { TrackingError } from "./errors";
import { trackingFingerprint, walletAccountFingerprint } from "./fingerprint";

export const scopeKey = (scope: TrackingScope) => scope.kind === "platform" ? "platform" : `restaurant:${scope.restaurantId}`;
type CaptureOptions = { mode: string; currency: string; collectionPrivateKey?: string | null; collectionPublicKey?: string | null; terminalBusinessCode?: string | null };
export type TrackingContext = TrackingCapture & {
  scopeKey: string; scopeKind: "platform" | "merchant"; restaurantId: string | null;
  walletAccountFingerprint: string; platformWalletAccountId: string | null;
  payoutCredentials: { mode: TrackingMode; publicKey: string; privateKey: string };
};
export async function resolveTrackingContext(scope: TrackingScope, captured?: CaptureOptions): Promise<TrackingContext> {
  let payout: { mode: string; publicKey: string | null; privateKey: string | null };
  let collection: { publicKey: string | null; privateKey: string | null };
  let collectionMode: string;
  let platformWalletAccountId: string | null = null;
  let terminalBusinessCode: string | null = null;
  if (scope.kind === "platform") {
    const config = await db.platformConfig.findUnique({ where: { id: "singleton" }, include: { platformWalletAccount: true } });
    const wallet = config?.platformWalletAccount;
    if (!wallet) throw new TrackingError("tracking_not_configured");
    platformWalletAccountId = wallet.id;
    payout = { mode: wallet.mode, publicKey: wallet.publicKey, privateKey: decrypt(wallet.privateKeyEnc) };
    collection = await getBillingCredentials();
    collectionMode = await getKushkiMode();
  } else {
    const tenant = await db.restaurant.findUnique({ where: { id: scope.restaurantId },
      select: { country: true, kushkiMode: true, kushkiPublicKey: true, kushkiPrivateKeyEnc: true, cloudTerminalBusinessCode: true } });
    if (!tenant) throw new TrackingError("tracking_not_configured");
    if (tenant.country !== "CO") throw new TrackingError("tracking_unsupported");
    collectionMode = await getRestaurantKushkiMode(tenant);
    terminalBusinessCode = captured?.terminalBusinessCode ?? tenant.cloudTerminalBusinessCode?.trim() ?? env.KUSHKI_BP_BUSINESS_CODE ?? null;
    collection = { publicKey: tenant.kushkiPublicKey, privateKey: tenant.kushkiPrivateKeyEnc ? decrypt(tenant.kushkiPrivateKeyEnc) : null };
    payout = { ...await getRestaurantPayoutCredentials(scope.restaurantId), mode: collectionMode };
  }
  const mode = captured?.mode ?? collectionMode;
  const currency = captured?.currency ?? "COP";
  if (!(["production", "sandbox"].includes(mode)) || payout.mode !== mode || currency !== "COP") throw new TrackingError("tracking_unsupported");
  const collectionPrivateKey = captured?.collectionPrivateKey ?? collection.privateKey;
  const collectionPublicKey = captured?.collectionPublicKey ?? collection.publicKey;
  if (!payout.publicKey || !payout.privateKey || !collectionPublicKey || !collectionPrivateKey
    || /^mock[_:-]/i.test(payout.privateKey) || /^mock[_:-]/i.test(collectionPrivateKey)) throw new TrackingError("tracking_not_configured");
  const safeMode = mode as TrackingMode;
  const payoutCredentials = { mode: safeMode, publicKey: payout.publicKey, privateKey: payout.privateKey };
  const walletFingerprint = walletAccountFingerprint(payoutCredentials);
  const collectionFingerprint = walletAccountFingerprint({ mode: safeMode, publicKey: collectionPublicKey, privateKey: collectionPrivateKey });
  return { scopeKey: scopeKey(scope), scopeKind: scope.kind, restaurantId: scope.kind === "merchant" ? scope.restaurantId : null,
    trackingKey: trackingFingerprint({ scopeKey: scopeKey(scope), mode: safeMode, currency, collection: collectionFingerprint, payout: walletFingerprint, terminalBusinessCode }),
    mode: safeMode, currency, walletAccountFingerprint: walletFingerprint, platformWalletAccountId, payoutCredentials };
}
/** A missing tracker must not interrupt a real charge. Missing bindings are
 * reported by the scanner instead of retroactively assigned to another account. */
export async function captureWalletTrackingContext(scope: TrackingScope, effective: CaptureOptions): Promise<TrackingCapture | null> {
  try {
    const context = await resolveTrackingContext(scope, effective);
    return { trackingKey: context.trackingKey, mode: context.mode, currency: context.currency };
  } catch { return null; }
}
