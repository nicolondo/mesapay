import { adminWalletApi, walletResponse } from "@/lib/platformWallet/api";
import { activeAccount } from "@/lib/platformWallet/config";
import { rateLimit } from "@/lib/rateLimit";
import { loadWalletIncoming } from "@/lib/walletIncoming/service";

/** Collections belong to the billing account. This does not assert that
 * the configured Transfer Out wallet receives those collections. */
export const GET = adminWalletApi(async (req) => {
  const requestedAccount = new URL(req.url).searchParams.get("accountId");
  if (!requestedAccount || requestedAccount.length > 128) return walletResponse({ error: "account_required" }, 400);
  const account = await activeAccount();
  if (requestedAccount !== account.id) return walletResponse({ error: "account_changed" }, 409);
  if (!await rateLimit("wallet-incoming:platform", 6, 60)) return walletResponse({ error: "rate_limited" }, 429);
  try {
    const report = await loadWalletIncoming({ kind: "platform" });
    if ((await activeAccount()).id !== account.id) return walletResponse({ error: "account_changed" }, 409);
    return walletResponse({ ...report, accountId: account.id });
  } catch {
    return walletResponse({ error: "incoming_unavailable" }, 503);
  }
});
