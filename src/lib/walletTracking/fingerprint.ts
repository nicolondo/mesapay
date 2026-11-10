import { createHmac, createHash } from "node:crypto";
import { requireSecretKey } from "@/lib/env";
import type { TrackingMode } from "./contracts";

function fingerprint(domain: string, value: unknown) {
  return createHmac("sha256", Buffer.from(requireSecretKey(), "hex")).update(JSON.stringify([domain, value])).digest("hex");
}
/** Server-side only: never return private keys or their unkeyed hashes. */
export function walletAccountFingerprint(input: { mode: TrackingMode; publicKey: string; privateKey: string }) {
  return fingerprint("wallet-account-v1", [input.mode, input.publicKey, input.privateKey]);
}
export function trackingFingerprint(input: { scopeKey: string; mode: TrackingMode; currency: string; collection: string; payout: string; terminalBusinessCode?: string | null }) {
  return fingerprint("wallet-tracking-v1", [input.scopeKey, input.mode, input.currency, input.collection, input.payout, input.terminalBusinessCode ?? null]);
}
export function entryPayloadHash(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
