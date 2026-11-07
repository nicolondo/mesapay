import { z } from "zod";
import { kushkiFetch, KushkiHttpError } from "@/lib/payments/kushki/client";
import type { WalletMode, WalletPayoutInput, WalletBank } from "./contracts";
import { providerStatusSchema } from "./validation";
import { WalletError } from "./errors";
import { UNREPORTED_WALLET_PENDING } from "@/lib/payments/walletPending";

export type WalletCredentials = { mode: WalletMode; publicKey: string; privateKey: string };
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const balanceSchema = z.object({ currentBalance: z.number().finite(), currency: z.enum(["COP", ""]).optional(), balanceDate: z.union([z.number(), z.string().max(100)]).optional() });
const bankSchema = z.array(z.object({ code: z.string().max(20).optional(), id: z.string().max(20).optional(), name: z.string().min(1).max(120) })).max(500);

/** Official CO API, checked 2026-11-06. All mutations explicitly disable retries.
 * https://api-docs.kushkipagos.com/colombia/online-payments/transfer-out
 * Private credentials never fall back to another account or the global mode.
 */
export async function walletBalance(account: WalletCredentials) {
  try {
    const raw = await kushkiFetch<unknown>("/wallet/v1/merchant/balance", {
      method: "GET", mode: account.mode, auth: { kind: "submerchant", privateKey: account.privateKey }, retries: 0,
    });
    const balance = balanceSchema.parse(raw);
    const availableCents = Math.round(balance.currentBalance * 100);
    if (!Number.isSafeInteger(availableCents) || availableCents < 0) throw new Error("invalid_balance");
    const date = balance.balanceDate === undefined ? null : new Date(balance.balanceDate);
    return { availableCents, balanceDate: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null, ...UNREPORTED_WALLET_PENDING };
  } catch (error) {
    if (error instanceof KushkiHttpError && error.status === 400) {
      try { if (JSON.parse(error.body)?.code === "WLT400") return { availableCents: 0, balanceDate: null, ...UNREPORTED_WALLET_PENDING }; } catch { /* Not a recognized empty-wallet response. */ }
    }
    throw new WalletError("balance_failed", 502);
  }
}
export async function walletBanks(account: WalletCredentials): Promise<WalletBank[]> {
  try {
    const raw = await kushkiFetch<unknown>("/payouts/transfer/v1/bankList", {
      method: "GET", mode: account.mode, auth: { kind: "submerchant_public", publicKey: account.publicKey }, retries: 0,
    });
    return bankSchema.parse(raw).map((bank) => ({ id: bank.code ?? bank.id ?? "", name: bank.name })).filter((bank) => /^[0-9A-Za-z_-]{1,20}$/.test(bank.id));
  } catch { throw new WalletError("banks_failed", 502); }
}
export async function tokenizePayout(account: WalletCredentials, input: Pick<WalletPayoutInput, "amountCents" | "destination">) {
  const d = input.destination;
  const raw = await kushkiFetch<unknown>("/payouts/transfer/v1/tokens", {
    method: "POST", mode: account.mode, auth: { kind: "submerchant_public", publicKey: account.publicKey }, retries: 0,
    body: { documentType: d.docType === "PA" ? "PP" : d.docType, documentNumber: d.docNumber,
      accountType: d.accountType === "corriente" ? "CC" : "CA", accountNumber: d.accountNumber,
      bankId: d.bankId, totalAmount: input.amountCents / 100, currency: "COP" },
  });
  return z.object({ token: z.string().min(1).max(1000) }).parse(raw).token;
}
export async function initializePayout(account: WalletCredentials, input: { token: string; amountCents: number; reference: string; webhookUrl: string; webhookSecret: string }) {
  const raw = await kushkiFetch<unknown>("/payouts/transfer/v1/init", {
    method: "POST", mode: account.mode, auth: { kind: "submerchant", privateKey: account.privateKey }, retries: 0,
    body: { token: input.token, amount: { subtotalIva: 0, subtotalIva0: input.amountCents / 100, iva: 0 },
      metadata: { reference: input.reference }, webhooks: [{ events: ["approvedTransaction", "declinedTransaction"],
        headers: [{ label: "Authorization", value: `Bearer ${input.webhookSecret}` }], urls: [input.webhookUrl] }] },
  });
  const result = z.object({ ticketNumber: idSchema, transactionReference: idSchema.optional() }).parse(raw);
  return { ticketNumber: result.ticketNumber, providerRef: result.transactionReference ?? null };
}
export async function queryPayout(account: WalletCredentials, ticket: string) {
  try {
    idSchema.parse(ticket);
    const raw = await kushkiFetch<unknown>(`/payouts/transfer/v1/transaction/${encodeURIComponent(ticket)}`, {
      method: "GET", mode: account.mode, auth: { kind: "submerchant", privateKey: account.privateKey }, retries: 0,
    });
    return providerStatusSchema.parse(raw);
  } catch { throw new WalletError("payout_status_unavailable", 502); }
}
export function definiteInitRejection(error: unknown) {
  return error instanceof KushkiHttpError && [400, 401, 403, 404, 422].includes(error.status);
}
