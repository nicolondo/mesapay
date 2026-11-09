import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { walletResponse } from "@/lib/platformWallet/api";
import { rateLimit } from "@/lib/rateLimit";
import { secureApi } from "@/lib/secureApi";
import { loadWalletIncoming } from "@/lib/walletIncoming/service";

export const GET = secureApi(async (req: Request) => {
  const session = await auth();
  if (!session?.user?.id || !["operator", "platform_admin", "group_admin"].includes(session.user.role)) {
    return walletResponse({ error: "unauthorized" }, 401);
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return walletResponse({ error: "unauthorized" }, 401);
  const requestedRestaurant = new URL(req.url).searchParams.get("restaurantId");
  if (!requestedRestaurant || requestedRestaurant.length > 128) return walletResponse({ error: "restaurant_required" }, 400);
  if (requestedRestaurant !== restaurantId) return walletResponse({ error: "restaurant_changed" }, 409);
  if (!await rateLimit(`wallet-incoming:merchant:${restaurantId}`, 6, 60)) return walletResponse({ error: "rate_limited" }, 429);
  try {
    const report = await loadWalletIncoming({ kind: "merchant", restaurantId });
    if (await getActiveRestaurantId() !== restaurantId) return walletResponse({ error: "restaurant_changed" }, 409);
    return walletResponse({ ...report, restaurantId });
  } catch {
    return walletResponse({ error: "incoming_unavailable" }, 503);
  }
});
