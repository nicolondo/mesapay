import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { ServeBoard } from "./ServeBoard";

export const dynamic = "force-dynamic";

export default async function ServePage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });

  // Surface rounds with at least one ready-but-not-yet-served item.
  // That's what the waiter can actually pick up. For "together" mode
  // we still include the round so we can show a waiting state with how
  // many dishes the kitchen still has to finish.
  const [rounds, cashPending, waiterCalls, cancelledPending] =
    await Promise.all([
      db.round.findMany({
        where: {
          order: { restaurantId, status: { notIn: ["paid", "cancelled"] } },
          items: { some: { kitchenStatus: "ready", servedAt: null } },
        },
        include: {
          order: { include: { table: true } },
          items: { orderBy: { id: "asc" } },
        },
        orderBy: { readyAt: "asc" },
      }),
      db.payment.findMany({
        where: {
          method: "demo_cash",
          status: "pending",
          order: { restaurantId, status: { notIn: ["paid", "cancelled"] } },
        },
        include: {
          order: { include: { table: true } },
        },
        orderBy: { createdAt: "asc" },
      }),
      db.order.findMany({
        where: {
          restaurantId,
          needsWaiter: true,
          status: { notIn: ["paid", "cancelled"] },
        },
        include: { table: true },
        orderBy: { waiterCalledAt: "asc" },
      }),
      // Cancelled rounds where the waiter still has to go tell the customer.
      db.round.findMany({
        where: {
          order: { restaurantId },
          status: "cancelled",
          cancellationAckedAt: null,
        },
        include: {
          order: { include: { table: true } },
          items: { orderBy: { id: "asc" } },
        },
        orderBy: { cancelledAt: "asc" },
      }),
    ]);

  return (
    <ServeBoard
      tenantSlug={tenant!.slug}
      serviceMode={tenant!.serviceMode}
      rounds={rounds.map((r) => ({
        id: r.id,
        seq: r.seq,
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
      cashPending={cashPending.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        createdAt: p.createdAt.toISOString(),
        order: {
          id: p.order.id,
          shortCode: p.order.shortCode,
          tableNumber: p.order.table.number,
        },
      }))}
      waiterCalls={waiterCalls.map((o) => ({
        id: o.id,
        shortCode: o.shortCode,
        tableNumber: o.table.number,
        calledAt: (o.waiterCalledAt ?? o.updatedAt).toISOString(),
      }))}
      cancelledPending={cancelledPending.map((r) => ({
        id: r.id,
        seq: r.seq,
        cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
        reason: r.cancellationReason ?? "",
        order: {
          id: r.order.id,
          shortCode: r.order.shortCode,
          tableNumber: r.order.table.number,
          orderType: r.order.orderType as "dineIn" | "pickup",
          pickupName: r.order.pickupName,
        },
        items: r.items.map((i) => ({
          id: i.id,
          qty: i.qty,
          name: i.nameSnapshot,
        })),
      }))}
    />
  );
}
