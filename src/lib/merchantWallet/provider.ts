import { z } from "zod";
import { kushkiFetch } from "@/lib/payments/kushki/client";
import type { WalletCredentials } from "@/lib/platformWallet/provider";
import type { MerchantDestination } from "./validation";
// These helpers do not hardcode currency: init uses the token's currency and
// query validates the returned payload. Platform transfers remain unchanged.
export { initializePayout, queryPayout, definiteInitRejection, walletBanks as merchantBanks } from "@/lib/platformWallet/provider";

export async function tokenizeMerchantPayout(account: WalletCredentials, input: { amountCents: number; currency: string; reference: string; destination: MerchantDestination }) {
  const d = input.destination;
  const raw = await kushkiFetch<unknown>("/payouts/transfer/v1/tokens", {
    method: "POST", mode: account.mode, auth: { kind: "submerchant_public", publicKey: account.publicKey }, retries: 0,
    body: { documentType: d.docType === "PA" ? "PP" : d.docType, documentNumber: d.docNumber,
      accountType: d.accountType === "corriente" ? "CC" : "CA", accountNumber: d.accountNumber,
      bankId: d.bankId, totalAmount: input.amountCents / 100, currency: input.currency, paymentDescription: input.reference },
  });
  return z.object({ token: z.string().min(1).max(1000) }).parse(raw).token;
}
