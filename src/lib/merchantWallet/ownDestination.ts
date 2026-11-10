import "server-only";
import { createHmac } from "node:crypto";
import { requireSecretKey } from "@/lib/env";
import { WalletError } from "@/lib/platformWallet/errors";
import { destinationSchema } from "./validation";

export function readOwnDestination(raw: unknown) {
  const b = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const parsed = destinationSchema.safeParse({ bankId: "unresolved", bankName: b.bankName, accountType: b.accountType,
    accountNumber: b.accountNumber, holderName: b.holderName, docType: b.holderDocType, docNumber: b.holderDocNumber });
  if (!parsed.success) throw new WalletError("bank_info_invalid", 400);
  return parsed.data;
}
/** An opaque review binding, not bank data. Never silently substitute a changed
 * onboarding destination after the operator confirmed the displayed account. */
export function ownDestinationFingerprint(raw: unknown): string | null {
  try {
    const d = readOwnDestination(raw);
    return createHmac("sha256", Buffer.from(requireSecretKey(), "hex"))
      .update(JSON.stringify(["merchant-own-destination-v1", d.bankName, d.accountType, d.accountNumber, d.docType, d.docNumber, d.holderName])).digest("hex");
  } catch { return null; }
}
