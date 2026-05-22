/**
 * Shared payment-provider types. These are intentionally provider-agnostic;
 * the Kushki implementation lives in src/lib/payments/kushki/ and exposes
 * the same shapes.
 */

export type Money = {
  amountCents: number;
  currency: "COP";
};

export type BankInfo = {
  bankName: string;
  accountType: "ahorros" | "corriente";
  accountNumber: string;
  holderName: string;
  holderDocType: "CC" | "CE" | "NIT" | "PA";
  holderDocNumber: string;
  // Auditing: was this filled in by hand or by Claude OCR?
  source: "manual" | "ai_extracted";
  aiConfidence?: number;
};

export type AutoDispersePolicy =
  | { enabled: false }
  | {
      enabled: true;
      mode: "daily" | "weekly" | "threshold";
      thresholdCents?: number;
      weekdays?: number[];
      // 24h "HH:MM" in America/Bogota
      time?: string;
    };

export type OnboardingDoc = {
  kind:
    | "cedula_rep_legal"
    | "rut"
    | "camara_comercio"
    | "bank_cert"
    | "estatutos"
    | "other";
  fileUrl: string;
  fileName: string;
  mimeType: string;
};

export type OnboardingSubmission = {
  legalName: string;
  taxId: string; // NIT
  contactEmail: string;
  contactPhone: string;
  bankInfo: BankInfo;
  documents: OnboardingDoc[];
};

export type MerchantStatus =
  | "not_started"
  | "submitted"
  | "in_review"
  | "active"
  | "rejected"
  | "suspended";

export type MerchantSummary = {
  merchantId: string;
  publicKey: string;
  privateKey: string;
  status: MerchantStatus;
  notes?: string;
};

export type ChargeRequest = {
  merchantId: string;
  amount: Money;
  // Provider-tokenised payment instrument (Apple Pay / Google Pay / card token)
  token: string;
  metadata: {
    orderId: string;
    paymentId: string;
    tableId?: string;
  };
};

export type ChargeResult = {
  providerRef: string;
  status: "approved" | "declined" | "pending";
  message?: string;
  raw: unknown;
};

export type TerminalPushRequest = {
  merchantId: string;
  deviceId: string;
  amount: Money;
  metadata: {
    orderId: string;
    paymentId: string;
  };
};

export type TerminalPushResult = {
  providerRef: string;
  // Terminal flows are async — the actual approve/decline arrives via webhook.
  // This is just the acknowledgement that the terminal received the request.
  status: "queued" | "delivered" | "failed";
  message?: string;
};

export type WalletBalance = {
  availableCents: number;
  pendingCents: number;
  currency: "COP";
};

export type WalletMovement = {
  externalRef: string;
  kind: "credit" | "debit" | "fee" | "dispersion" | "adjustment";
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  occurredAt: Date;
};

export type DispersionRequest = {
  merchantId: string;
  amount: Money;
  bankInfo: BankInfo;
  reference?: string;
};

export type DispersionResult = {
  providerRef: string;
  status: "queued" | "processing" | "completed" | "failed";
  estimatedSettlementAt?: Date;
};

/**
 * Single interface every provider must implement. We have one (Kushki)
 * today; if Wompi or another comes back later, it implements the same
 * surface and the rest of the code never needs to know which provider it
 * is talking to.
 */
export interface PaymentProvider {
  // Onboarding
  submitOnboarding(submission: OnboardingSubmission): Promise<MerchantSummary>;
  getMerchantStatus(merchantId: string): Promise<MerchantSummary>;

  // Charges (Apple Pay, Google Pay, etc.)
  chargeWithToken(req: ChargeRequest): Promise<ChargeResult>;

  // Smart-POS terminal cloud push
  pushToTerminal(req: TerminalPushRequest): Promise<TerminalPushResult>;
  cancelTerminalTransaction(
    merchantId: string,
    providerRef: string,
  ): Promise<void>;

  // Wallet
  getBalance(merchantId: string): Promise<WalletBalance>;
  listMovements(
    merchantId: string,
    opts: { sinceMs?: number; limit?: number },
  ): Promise<WalletMovement[]>;
  disburse(req: DispersionRequest): Promise<DispersionResult>;
}
