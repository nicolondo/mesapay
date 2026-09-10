import { rateLimit } from "@/lib/rateLimit";

// Both single and bulk generation spend the same restaurant-wide budget.
// Bulk is capped at 25 dishes. Atomic database counters work across servers.
export async function allowMenuAi(restaurantId: string) {
  return (
    (await rateLimit(`menu-ai:minute:${restaurantId}`, 10, 60)) &&
    (await rateLimit(`menu-ai:day:${restaurantId}`, 100, 86400))
  );
}
