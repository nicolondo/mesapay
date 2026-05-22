import { z } from "zod";

/**
 * Zod schemas mirroring the Kushki Partner API payloads we send/receive.
 *
 * These will likely need minor tweaks once we receive the real partner
 * docs. The shapes here follow Kushki's public API patterns
 * (https://api-docs.kushkipagos.com/) — kebab-case URLs, JSON bodies,
 * snake_case-or-camelCase fields. We pick the shapes consistent with the
 * production REST docs and adapt on first real call.
 */

export const MerchantStatusSchema = z.enum([
  "not_started",
  "submitted",
  "in_review",
  "active",
  "rejected",
  "suspended",
]);
export type MerchantStatus = z.infer<typeof MerchantStatusSchema>;

export const SubmerchantCreateResponseSchema = z.object({
  merchantId: z.string(),
  publicMerchantId: z.string(),
  privateMerchantId: z.string(),
  status: MerchantStatusSchema,
  notes: z.string().optional(),
});
export type SubmerchantCreateResponse = z.infer<
  typeof SubmerchantCreateResponseSchema
>;

export const ChargeResponseSchema = z.object({
  ticketNumber: z.string(),
  transactionReference: z.string(),
  approvalCode: z.string().optional(),
  status: z.enum(["APPROVAL", "DECLINED", "INITIALIZED"]),
  responseText: z.string().optional(),
  amount: z.number(),
});
export type ChargeResponse = z.infer<typeof ChargeResponseSchema>;

export const TerminalPushResponseSchema = z.object({
  transactionReference: z.string(),
  deviceId: z.string(),
  status: z.enum(["queued", "delivered", "failed"]),
  message: z.string().optional(),
});
export type TerminalPushResponse = z.infer<typeof TerminalPushResponseSchema>;

export const BalanceResponseSchema = z.object({
  availableAmount: z.number(),
  pendingAmount: z.number(),
  currency: z.literal("COP"),
});
export type BalanceResponse = z.infer<typeof BalanceResponseSchema>;

export const MovementResponseSchema = z.object({
  externalReference: z.string(),
  type: z.enum(["credit", "debit", "fee", "dispersion", "adjustment"]),
  amount: z.number(),
  balanceAfter: z.number(),
  description: z.string(),
  occurredAt: z.string(), // ISO
});
export type MovementResponse = z.infer<typeof MovementResponseSchema>;

export const DispersionResponseSchema = z.object({
  dispersionId: z.string(),
  status: z.enum(["queued", "processing", "completed", "failed"]),
  estimatedSettlementAt: z.string().optional(),
});
export type DispersionResponse = z.infer<typeof DispersionResponseSchema>;

export const WebhookEventSchema = z.object({
  eventId: z.string(),
  type: z.string(),
  merchantId: z.string().optional(),
  data: z.unknown(),
  createdAt: z.string(),
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
