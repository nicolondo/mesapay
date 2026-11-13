export type WalletMode = "sandbox" | "production";
export type WalletAccountDTO = { id: string; label: string; mode: WalletMode; publicKey: string; hasPrivateKey: boolean; createdAt: string };
export type WalletConfigDTO = { account: WalletAccountDTO | null; billingConfigured: boolean };
export type WalletBalanceDTO = import("@/lib/payments/walletPending").WalletPendingBalance & { accountId: string; availableCents: number; currency: "COP"; balanceDate: string | null; queriedAt: string };
export type WalletBank = { id: string; name: string };
export type WalletPayoutInput = {
  accountId: string; idempotencyKey: string; amountCents: number; confirmed: true; description?: string;
  destination: { bankId: string; accountType: "ahorros" | "corriente"; accountNumber: string; docType: "CC" | "CE" | "NIT" | "PA"; docNumber: string; holderName: string };
};
export type PlatformPayoutDTO = {
  id: string; idempotencyKey: string; accountId: string; accountLabel: string; mode: WalletMode;
  amountCents: number; currency: "COP"; bankName: string; accountType: string; accountLast4: string;
  holderName: string; description: string | null;
  status: "submitting" | "initialized" | "approved" | "declined" | "unknown" | "failed";
  ticketNumber: string | null; providerRef: string | null; reference: string;
  errorCode: string | null; createdAt: string; settledAt: string | null;
};
