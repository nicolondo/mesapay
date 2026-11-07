export type {
  WalletAccountDTO as WalletAccount,
  WalletConfigDTO as WalletConfig,
  WalletBalanceDTO as WalletBalance,
  WalletBank,
  PlatformPayoutDTO as Payout,
  WalletPayoutInput as PayoutInput,
} from "@/lib/platformWallet/contracts";

export class WalletRequestError extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}
/** Never exposes provider response text, which may contain banking information. */
export async function walletRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`/api/admin/wallet/${path}`, {
      ...init, cache: "no-store", signal: controller.signal,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new WalletRequestError(data?.error ?? "request_failed", response.status);
    if (data === null) throw new WalletRequestError("request_failed");
    return data as T;
  } catch (error) {
    if (error instanceof WalletRequestError) throw error;
    throw new WalletRequestError("connection_failed");
  } finally { clearTimeout(timer); }
}
export function errorCode(error: unknown): string {
  return error instanceof WalletRequestError ? error.code : "request_failed";
}
export const fieldClass = "mt-1 w-full min-w-0 rounded-xl border border-op-border bg-op-bg px-3 py-3 text-sm outline-none focus:border-terracotta focus:ring-2 focus:ring-terracotta/15 disabled:opacity-50";
export const secondaryButton = "min-h-11 rounded-full border border-op-border px-4 py-2 text-sm font-medium hover:bg-op-bg disabled:opacity-50 disabled:cursor-not-allowed";
export const primaryButton = "min-h-11 rounded-full bg-ink px-5 py-2 text-sm font-medium text-bone hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed";
