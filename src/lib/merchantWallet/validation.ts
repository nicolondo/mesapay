import { createHash } from "node:crypto";
import { z } from "zod";
import type { Payout } from "@prisma/client";
import type { ProviderStatus } from "@/lib/platformWallet/validation";

export const destinationSchema = z.object({
  bankId: z.string().regex(/^[a-zA-Z0-9_-]{1,20}$/), bankName: z.string().trim().min(2).max(120),
  accountType: z.enum(["ahorros", "corriente"]), accountNumber: z.string().trim().regex(/^\d{4,34}$/),
  docType: z.enum(["CC", "CE", "NIT", "PA"]), docNumber: z.string().trim().regex(/^[A-Za-z0-9-]{4,20}$/),
  holderName: z.string().trim().min(3).max(120),
}).strict();
export const merchantPayoutSchema = z.object({
  restaurantId: z.string().min(1).max(100), idempotencyKey: z.string().uuid(),
  // Payout.amountCents is a PostgreSQL Int; never send an amount we cannot persist.
  amountCents: z.number().int().min(100).max(2_147_483_647), destination: destinationSchema.optional(),
  ownDestinationFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.destination && !value.ownDestinationFingerprint || value.destination && value.ownDestinationFingerprint)
    ctx.addIssue({ code: "custom", message: "invalid_destination_context", path: ["ownDestinationFingerprint"] });
});
export type MerchantPayoutInput = z.infer<typeof merchantPayoutSchema>;
export type MerchantDestination = z.infer<typeof destinationSchema>;
export function merchantPayloadFingerprint(input: MerchantPayoutInput) {
  const d = input.destination;
  return createHash("sha256").update(JSON.stringify([input.restaurantId, input.amountCents,
    d ? [d.bankId, d.bankName, d.accountType, d.accountNumber, d.docType, d.docNumber, d.holderName] : input.ownDestinationFingerprint])).digest("hex");
}
export function merchantStatusMatches(p: Pick<Payout, "amountCents" | "currency" | "reference" | "ticketNumber" | "providerRef" | "bankId">, s: ProviderStatus) {
  const cents = s.totalAmount * 100;
  if (!Number.isSafeInteger(Math.round(cents)) || Math.abs(cents - Math.round(cents)) > 0.00001 || Math.round(cents) !== p.amountCents) return false;
  if (s.currency !== p.currency || s.transactionType !== "PAYOUT" || !p.bankId || s.bankId !== p.bankId || !p.reference) return false;
  if (p.ticketNumber && s.ticketNumber !== p.ticketNumber) return false;
  if (p.providerRef && s.transactionReference !== p.providerRef) return false;
  if (s.metadata?.reference && s.metadata.reference !== p.reference) return false;
  return !!p.ticketNumber || s.metadata?.reference === p.reference;
}
