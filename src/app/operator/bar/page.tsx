import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { KitchenBoard } from "../kitchen/KitchenBoard";

export const dynamic = "force-dynamic";

/**
 * Bar board. Same UX as the kitchen board, scoped to items routed to
 * `station="bar"`. Only reachable when the restaurant has hasBar=true —
 * a passing operator without the flag will get bounced to /operator
 * (nav link is hidden anyway, but we belt-and-suspenders this in case
 * somebody bookmarks the URL).
 *
 * A round with both bar + kitchen items shows up in both boards, each
 * board showing only its own items. The "round ready" trigger fires
 * when ALL items across all stations are ready (see order-items route).
 */
export default async function BarPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  if (!tenant?.hasBar) {
    redirect("/operator/kitchen");
  }

  const rounds = await db.round.findMany({
    where: {
      order: { restaurantId },
      status: { in: ["placed", "in_kitchen", "ready"] },
      items: { some: { station: "bar" } },
    },
    include: {
      order: { include: { table: true } },
      items: { where: { station: "bar" } },
    },
    orderBy: { placedAt: "asc" },
  });

  return (
    <KitchenBoard
      tenantSlug={tenant.slug}
      serviceMode={tenant.serviceMode}
      rounds={rounds.map((r) => ({
        id: r.id,
        seq: r.seq,
        status: r.status as "placed" | "in_kitchen" | "ready",
        placedAt: r.placedAt.toISOString(),
        readyAt: r.readyAt ? r.readyAt.toISOString() : null,
        order: {
          id: r.order.id,
          shortCode: r.order.shortCode,
          tableNumber: r.order.table.number,
          servingMode: r.order.servingMode,
          orderType: r.order.orderType as "dineIn" | "pickup",
          pickupName: r.order.pickupName,
          etaMinutes: r.order.etaMinutes,
          readyEta: r.order.readyEta ? r.order.readyEta.toISOString() : null,
        },
        items: r.items.map((i) => ({
          id: i.id,
          qty: i.qty,
          name: i.nameSnapshot,
          modifiers:
            i.modifierSelections && typeof i.modifierSelections === "object"
              ? Object.values(i.modifierSelections as Record<string, string>)
              : [],
          notes: i.notes ?? null,
          guestName: i.guestName ?? null,
          kitchenStatus: i.kitchenStatus,
          categoryKind: i.categoryKind,
          servedAt: i.servedAt ? i.servedAt.toISOString() : null,
        })),
      }))}
    />
  );
}
