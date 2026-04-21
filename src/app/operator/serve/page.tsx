import { auth } from "@/auth";
import { db } from "@/lib/db";
import { ServeBoard } from "./ServeBoard";

export const dynamic = "force-dynamic";

export default async function ServePage() {
  const session = await auth();
  const restaurantId = session!.user!.restaurantId;
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });

  // Surface rounds with at least one ready-but-not-yet-served item.
  // That's what the waiter can actually pick up. For "together" mode
  // we still include the round so we can show a waiting state with how
  // many dishes the kitchen still has to finish.
  const rounds = await db.round.findMany({
    where: {
      order: { restaurantId, status: { notIn: ["paid", "cancelled"] } },
      items: { some: { kitchenStatus: "ready", servedAt: null } },
    },
    include: {
      order: { include: { table: true } },
      items: { orderBy: { id: "asc" } },
    },
    orderBy: { readyAt: "asc" },
  });

  return (
    <ServeBoard
      tenantSlug={tenant!.slug}
      rounds={rounds.map((r) => ({
        id: r.id,
        seq: r.seq,
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
          servedAt: i.servedAt ? i.servedAt.toISOString() : null,
        })),
      }))}
    />
  );
}
