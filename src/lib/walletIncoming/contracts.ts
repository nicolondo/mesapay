/** Informational reconciliation only; none of these fields denotes a wallet credit. */
export type WalletIncomingStatus = "available" | "permission_required" | "credentials_missing" | "unavailable" | "unsupported";
export type WalletIncomingScope = { kind: "platform" } | { kind: "merchant"; restaurantId: string };
export type WalletIncomingReport = {
  grossCents: number;
  netCents: number;
  currency: string;
  paymentDate: string;
};
export type WalletIncomingCharge = {
  id: string;
  source: "order" | "subscription" | "reservation" | "voucher";
  occurredAt: string;
  dateBasis: "payment" | "record";
  amountCents: number;
  currency: string | null;
  refundedCents: number;
  report?: WalletIncomingReport;
};
export type WalletIncomingView = {
  status: WalletIncomingStatus;
  /** Mode of this report request, never an assertion about historical charges. */
  reportMode: "sandbox" | "production" | null;
  periodStart: string;
  periodEnd: string;
  queriedAt: string;
  reportThrough: string;
  localCharges: WalletIncomingCharge[];
  localTruncated: boolean;
  unmatchedReportCount: number;
  /** Only the completeness of provider pagination, not proof of a wallet balance. */
  reportComplete: boolean;
};
