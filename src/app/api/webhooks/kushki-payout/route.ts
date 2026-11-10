import { secureApi } from "@/lib/secureApi";
import { rateLimit } from "@/lib/rateLimit";
import { walletJson, walletResponse } from "@/lib/platformWallet/api";
import { WalletError } from "@/lib/platformWallet/errors";
import { callbackTicket } from "@/lib/platformWallet/validation";
import { authorizeMerchantWebhook, refreshMerchantPayout } from "@/lib/merchantWallet/status";

/** A callback is only a request to query Kushki. Its claimed status, amount,
 * references and messages are never applied to the payout or logged. Old
 * unauthenticated callbacks cannot turn legacy records into verified outflows. */
export const POST = secureApi(async (req: Request) => {
  try {
    const ip = (req.headers.get("x-real-ip") ?? "unattributed").slice(0, 128);
    if (!await rateLimit(`merchant-payout-webhook-ip:${ip}`, 120, 60)) return walletResponse({ error: "rate_limited" }, 429);
    const id = new URL(req.url).searchParams.get("payoutId") ?? "";
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new WalletError("invalid_webhook", 401);
    const authorization = req.headers.get("authorization");
    const restaurantId = await authorizeMerchantWebhook(id, authorization);
    if (!await rateLimit(`merchant-payout-webhook:${id}`, 60, 60)) return walletResponse({ error: "rate_limited" }, 429);
    const body = await walletJson(req);
    await refreshMerchantPayout(restaurantId, id, { authorization, ticket: callbackTicket(body) });
    return walletResponse({ ok: true });
  } catch (error) {
    return walletResponse({ error: error instanceof WalletError ? error.code : "payout_status_unavailable" }, error instanceof WalletError ? error.status : 503);
  }
});
