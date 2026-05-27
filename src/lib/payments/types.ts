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
    | "origen_fondos"
    | "estados_financieros"
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
  // Provider-tokenised payment instrument (Apple Pay token today; the
  // type stays generic so we can plug in other wallets later).
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

/**
 * PSE (Pagos Seguros en Línea) — flow estándar colombiano. El user
 * elige su banco, el provider devuelve una URL a la página de
 * autenticación del banco, el banco redirige de vuelta a nuestra app
 * cuando termina, y un webhook confirma el resultado final.
 */
export type PseBank = {
  /** Código numérico del banco (ej. "1007" Bancolombia). */
  code: string;
  /** Nombre comercial visible al usuario. */
  name: string;
};

export type PsePersonType = "natural" | "juridica";
export type PseDocType = "CC" | "CE" | "NIT" | "PA" | "TI";

export type PseInitRequest = {
  /** Private merchant key del sub-merchant (auth Private-Merchant-Id). */
  merchantId: string;
  amount: Money;
  /** Datos del pagador — requeridos por PSE/ASOBANCARIA. Email + doc
   * son los obligatorios; nombre y apellido los muestra Kushki en su
   * página hosted recolectándolos del banco, no los recibimos acá. */
  buyer: {
    email: string;
    docType: PseDocType;
    docNumber: string;
    personType: PsePersonType;
  };
  /** Código del banco que el diner eligió. Lo pasamos a Kushki para
   * que abra directamente la página del banco sin un paso extra. */
  bankCode: string;
  /** Descripción que aparece en el extracto bancario del pagador. */
  paymentDescription?: string;
  /** URL absoluta a la que Kushki redirige cuando termina. */
  callbackUrl: string;
  metadata: {
    orderId: string;
    paymentId: string;
  };
};

export type PseInitResult = {
  providerRef: string;
  /** URL del banco a la que mandamos al user con un redirect 302. */
  redirectUrl: string;
  /** Siempre "pending" — el estado final viene por webhook. */
  status: "pending";
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

  // Charges (Apple Pay token today; provider stays generic for the future).
  chargeWithToken(req: ChargeRequest): Promise<ChargeResult>;

  // PSE (redirect-based bank transfer)
  listPseBanks(publicKey: string): Promise<PseBank[]>;
  initiatePse(req: PseInitRequest): Promise<PseInitResult>;

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
