import { secureApi } from "@/lib/secureApi";
import { rateLimit } from "@/lib/rateLimit";
import { walletJson, walletResponse } from "@/lib/platformWallet/api";
import { authorizePlatformWebhook, refreshPlatformPayout } from "@/lib/platformWallet/status";
import { callbackTicket } from "@/lib/platformWallet/validation";
import { WalletError } from "@/lib/platformWallet/errors";

export const POST = secureApi(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  try {
    // nginx replaces X-Real-IP. One IP bucket spans all guessed IDs, before DB.
    const ip = (req.headers.get("x-real-ip") ?? "unattributed").slice(0, 128);
    if (!await rateLimit(`platform-wallet-webhook-ip:${ip}`, 120, 60)) return walletResponse({ error: "rate_limited" }, 429);
    const { id } = await ctx.params;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return walletResponse({ error: "invalid_webhook" }, 401);
    const authorization = req.headers.get("authorization");
    await authorizePlatformWebhook(id, authorization);
    if (!await rateLimit(`platform-wallet-webhook:${id}`, 60, 60)) return walletResponse({ error: "rate_limited" }, 429);
    const body = await walletJson(req);
    await refreshPlatformPayout(id, { authorization, ticket: callbackTicket(body) });
    return walletResponse({ ok: true });
  } catch (error) {
    if (error instanceof WalletError) return walletResponse({ error: error.code }, error.status);
    throw error;
  }
});
