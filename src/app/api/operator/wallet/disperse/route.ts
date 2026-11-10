import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { secureApi } from "@/lib/secureApi";
import { rateLimit } from "@/lib/rateLimit";
import { walletJson, walletResponse } from "@/lib/platformWallet/api";
import { WalletError } from "@/lib/platformWallet/errors";
import { submitMerchantPayout } from "@/lib/merchantWallet/service";
import { refreshMerchantPayout } from "@/lib/merchantWallet/status";
import { merchantPayoutDTO } from "@/lib/merchantWallet/dto";

async function scope(req: Request) {
  const session = await auth();
  if (!session?.user?.id || !["operator", "platform_admin", "group_admin"].includes(session.user.role)) throw new WalletError("unauthorized", 401);
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) throw new WalletError("no_restaurant", 400);
  if (!await rateLimit(`merchant-payout:${session.user.id}:${restaurantId}:${req.method}`, req.method === "GET" ? 60 : 20, 60)) throw new WalletError("rate_limited", 429);
  return { restaurantId, actor: { id: session.user.id, email: session.user.email ?? "", role: session.user.role } };
}

export const POST = secureApi(async (req: Request) => {
  try {
    const { restaurantId, actor } = await scope(req);
    return walletResponse(await submitMerchantPayout(restaurantId, await walletJson(req), actor));
  } catch (error) {
    return walletResponse({ error: error instanceof WalletError ? error.code : "payout_unavailable" }, error instanceof WalletError ? error.status : 503);
  }
});

/** Recovery consults one durable attempt; it never tokenizes or resends it. */
export const GET = secureApi(async (req: Request) => {
  try {
    const { restaurantId } = await scope(req);
    const params = new URL(req.url).searchParams;
    const parsed = z.object({ restaurantId: z.string().min(1).max(100), idempotencyKey: z.string().uuid() }).safeParse({ restaurantId: params.get("restaurantId"), idempotencyKey: params.get("idempotencyKey") });
    if (!parsed.success) throw new WalletError("invalid_payload", 400);
    if (parsed.data.restaurantId !== restaurantId) throw new WalletError("tenant_changed");
    const payout = await db.payout.findUnique({ where: { idempotencyKey: parsed.data.idempotencyKey } });
    if (!payout || payout.restaurantId !== restaurantId) return walletResponse({ payout: null });
    try { return walletResponse({ payout: await refreshMerchantPayout(restaurantId, payout.id) }); }
    catch (error) {
      // An early webhook may have updated the row during a failed GET. Return
      // the newest persisted state instead of restoring the initial snapshot.
      const current = await db.payout.findUnique({ where: { id: payout.id } });
      if (!current || current.restaurantId !== restaurantId) throw new WalletError("payout_not_found", 404);
      return walletResponse({ payout: merchantPayoutDTO(current), refreshError: error instanceof WalletError ? error.code : "payout_status_unavailable" });
    }
  } catch (error) {
    return walletResponse({ error: error instanceof WalletError ? error.code : "payout_unavailable" }, error instanceof WalletError ? error.status : 503);
  }
});
