import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { WalletPayoutInput } from "./contracts";

export const configSchema = z.object({
  label: z.string().trim().min(2).max(100), mode: z.enum(["sandbox", "production"]),
  publicKey: z.string().trim().min(1).max(500), privateKey: z.string().trim().max(500).optional(),
}).strict();
export const payoutSchema = z.object({
  accountId: z.string().min(1).max(100), idempotencyKey: z.string().uuid(),
  amountCents: z.number().int().min(100_000).max(1_390_000_000_000), confirmed: z.literal(true),
  description: z.string().trim().max(200).optional(),
  destination: z.object({
    bankId: z.string().regex(/^[0-9A-Za-z_-]{1,20}$/), accountType: z.enum(["ahorros", "corriente"]),
    accountNumber: z.string().trim().regex(/^\d{4,34}$/), docType: z.enum(["CC", "CE", "NIT", "PA"]),
    docNumber: z.string().trim().regex(/^[A-Za-z0-9-]{4,20}$/), holderName: z.string().trim().min(3).max(120),
  }).strict(),
}).strict();
export function payloadFingerprint(input: WalletPayoutInput) {
  const { destination: d } = input;
  return createHash("sha256").update(JSON.stringify([input.accountId, input.amountCents, d.bankId, d.accountType,
    d.accountNumber, d.docType, d.docNumber, d.holderName, input.description ?? ""])).digest("hex");
}
export function safeCents(value: bigint) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid_money");
  return amount;
}
export const providerStatusSchema = z.object({
  ticketNumber: z.string().min(1).max(100), transactionReference: z.string().min(1).max(100), totalAmount: z.number().finite().nonnegative(),
  currency: z.string().max(10), bankId: z.string().max(20), transactionType: z.string().max(30), transactionStatus: z.string().max(50),
  metadata: z.object({ reference: z.string().max(100).optional() }).optional(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
export function statusMatches(p: { amountCents: bigint; reference: string; ticketNumber: string | null; providerRef: string | null; bankId: string }, s: ProviderStatus) {
  if (s.currency !== "COP" || s.transactionType !== "PAYOUT" || s.bankId !== p.bankId || Math.round(s.totalAmount * 100) !== safeCents(p.amountCents)) return false;
  if (p.ticketNumber && s.ticketNumber !== p.ticketNumber) return false;
  if (p.providerRef && s.transactionReference !== p.providerRef) return false;
  if (s.metadata?.reference && s.metadata.reference !== p.reference) return false;
  return !!p.ticketNumber || s.metadata?.reference === p.reference;
}
export function terminalStatus(raw: string): "approved" | "declined" | "initialized" | null {
  if (["APPROVAL", "APPROVED"].includes(raw)) return "approved";
  if (raw === "DECLINED") return "declined";
  return raw === "INITIALIZED" ? "initialized" : null;
}
export function callbackTicket(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const ticket = b.ticketNumber;
  return typeof ticket === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(ticket) ? ticket : null;
}
export function verifyWebhookToken(header: string | null, secret: string) {
  if (!header || !secret) return false;
  const actual = Buffer.from(header); const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
