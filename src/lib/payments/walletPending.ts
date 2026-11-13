/** Incoming funds are separate from money currently available for payouts.
 * Unknown is never zero, including an empty available-wallet response.
 */
export type WalletPendingBalance =
  | { pendingCents: number; pendingStatus: "reported"; pendingUpdatedAt: string | null }
  | { pendingCents: null; pendingStatus: "not_reported" | "unavailable"; pendingUpdatedAt: null };

// The documented Balance for Payouts response does not report incoming funds.
// Do not infer them from available balance, its timestamp, or local sales.
// https://api-docs.kushkipagos.com/es/saldo-para-payouts-36274558e0
export const UNREPORTED_WALLET_PENDING = Object.freeze({
  pendingCents: null,
  pendingStatus: "not_reported",
  pendingUpdatedAt: null,
} as const);
