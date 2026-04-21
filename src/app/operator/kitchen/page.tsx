import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { KitchenBoard } from "./KitchenBoard";

export const dynamic = "force-dynamic";

export default async function KitchenPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });
  const rounds = await db.round.findMany({
    where: {
      order: { restaurantId },
      status: { in: ["placed", "in_kitchen", "ready"] },
    },
    include: {
      order: { include: { table: true } },
      items: true,
    },
    orderBy: { placedAt: "asc" },
  });

  return (
    <KitchenBoard
      tenantSlug={tenant!.slug}
      serviceMode={tenant!.serviceMode}
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
