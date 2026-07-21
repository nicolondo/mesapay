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

// Schema permisivo: Kushki Colombia en sandbox solo devuelve
// {ticketNumber, transactionReference} en charges exitosos via
// /card/v1/charges — los campos `status`/`amount` que aparecen en
// otros docs NO vienen en este flow. Si los exigimos como required
// (como hacíamos antes), zod falla validación → kushkiFetch retry-ea
// con el MISMO token → segundo charge devuelve 577 "token ya usado"
// porque Kushki ya lo consumió en la primer llamada exitosa.
export const ChargeResponseSchema = z
  .object({
    ticketNumber: z.string(),
    transactionReference: z.string(),
    approvalCode: z.string().optional(),
    status: z.enum(["APPROVAL", "DECLINED", "INITIALIZED"]).optional(),
    responseText: z.string().optional(),
    amount: z.number().optional(),
    // fullResponse:"v2" agrega un bloque `details` con la info rica del cobro.
    details: z.record(z.string(), z.unknown()).optional(),
  })
  // Retenemos cualquier campo extra de Kushki (v2 mete varios) para que quede
  // en KushkiTransaction.raw sin tener que enumerarlos todos.
  .passthrough();
export type ChargeResponse = z.infer<typeof ChargeResponseSchema>;

export const TerminalPushResponseSchema = z.object({
  transactionReference: z.string(),
  deviceId: z.string(),
  status: z.enum(["queued", "delivered", "failed"]),
  message: z.string().optional(),
});
export type TerminalPushResponse = z.infer<typeof TerminalPushResponseSchema>;

// Respuesta real de GET /wallet/v1/merchant/balance:
//   { "balanceDate": 1784307365153, "currency": "", "currentBalance": 99999533646 }
// `currency` suele venir vacío y `currentBalance` es el saldo total (no hay
// desglose available/pending). passthrough por si Kushki agrega campos.
export const BalanceResponseSchema = z
  .object({
    currentBalance: z.number(),
    balanceDate: z.number().optional(),
    currency: z.string().optional(),
  })
  .passthrough();
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

// Transfer Out (payouts): respuestas reales de la doc.
//   POST /payouts/transfer/v1/tokens → 201 { token }
//   POST /payouts/transfer/v1/init   → 201 { status: "INITIALIZED",
//                                            ticketNumber, transactionReference }
export const TransferOutTokenSchema = z
  .object({ token: z.string() })
  .passthrough();
export type TransferOutToken = z.infer<typeof TransferOutTokenSchema>;

export const TransferOutInitSchema = z
  .object({
    status: z.string().optional(),
    ticketNumber: z.string().optional(),
    transactionReference: z.string().optional(),
  })
  .passthrough();
export type TransferOutInit = z.infer<typeof TransferOutInitSchema>;

export const WebhookEventSchema = z.object({
  eventId: z.string(),
  type: z.string(),
  merchantId: z.string().optional(),
  data: z.unknown(),
  createdAt: z.string(),
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
