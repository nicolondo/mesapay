import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { formatItemSelections } from "@/lib/modifiers";
import { getMeseroScope } from "@/lib/meseroScope";
import { ServeBoard } from "./ServeBoard";

export const dynamic = "force-dynamic";

export default async function ServePage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId } });

  // If the current user is a `mesero` with assigned table numbers, narrow
  // every query below to those tables. Empty assignment / other roles =
  // no filter. The filter targets order.table.number which works whether
  // the table is dine-in (real number) or the pickup pseudo-table (-1).
  const scope = await getMeseroScope();
  const tableFilter = scope.scoped
    ? { table: { number: { in: scope.tableNumbers ?? [] } } }
    : {};

  // Surface rounds with at least one ready-but-not-yet-served item.
  // That's what the waiter can actually pick up. For "together" mode
  // we still include the round so we can show a waiting state with how
  // many dishes the kitchen still has to finish.
  const [
    rounds,
    cashPending,
    terminalPending,
    waiterCalls,
    cancelledPending,
    devices,
  ] = await Promise.all([
    db.round.findMany({
      where: {
        order: {
          restaurantId,
          // IMPORTANTE: incluimos órdenes pagas. Si el cliente paga
          // antes de que le sirvan TODO (caso común — paga apenas se
          // sentó o pidió la cuenta antes de que la cocina terminara),
          // los items siguen kitchenState=ready + servedAt=null y el
          // mesero TIENE que entregarlos. Antes excluíamos "paid" y
          // se perdían del Salón. Sólo excluimos "cancelled" — ahí sí
          // el food se tira, no se entrega.
          status: { not: "cancelled" },
          ...tableFilter,
        },
        items: {
          some: { kitchenStatus: "ready", servedAt: null, cancelledAt: null },
        },
      },
      include: {
        order: { include: { table: true } },
        items: {
          where: { cancelledAt: null },
          orderBy: { id: "asc" },
          include: { menuItem: { select: { modifiers: true } } },
        },
      },
      orderBy: { readyAt: "asc" },
    }),
    db.payment.findMany({
      where: {
        method: "demo_cash",
        status: "pending",
        order: {
          restaurantId,
          status: { notIn: ["paid", "cancelled"] },
          ...tableFilter,
        },
      },
      include: {
        order: { include: { table: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    // Datáfono requests waiting for the operator/cashier to push the
    // amount to the actual terminal. Same urgency as cash requests.
    db.payment.findMany({
      where: {
        method: "kushki_card_terminal",
        status: "pending",
        order: {
          restaurantId,
          status: { notIn: ["paid", "cancelled"] },
          ...tableFilter,
        },
      },
      include: { order: { include: { table: true } } },
      orderBy: { createdAt: "asc" },
    }),
    db.order.findMany({
      where: {
        restaurantId,
        needsWaiter: true,
        status: { notIn: ["paid", "cancelled"] },
        ...tableFilter,
      },
      include: { table: true },
      orderBy: { waiterCalledAt: "asc" },
    }),
    // Cancelled rounds where the waiter still has to go tell the customer.
    db.round.findMany({
      where: {
        order: { restaurantId, ...tableFilter },
        status: "cancelled",
        cancellationAckedAt: null,
      },
      include: {
        order: { include: { table: true } },
        items: { orderBy: { id: "asc" } },
      },
      orderBy: { cancelledAt: "asc" },
    }),
    db.terminalDevice.findMany({
      where: { restaurantId, active: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const device = devices[0] ?? null;

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
          modifiers: formatItemSelections(
            i.modifierSelections,
            i.menuItem?.modifiers,
          ),
          notes: i.notes ?? null,
          guestName: i.guestName ?? null,
          kitchenStatus: i.kitchenStatus,
          categoryKind: i.categoryKind,
          station: i.station,
          servedAt: i.servedAt ? i.servedAt.toISOString() : null,
        })),
      }))}
      cashPending={cashPending.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        tipCents: p.tipCents,
        cashTenderCents: p.cashTenderCents,
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
      terminalPending={terminalPending.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        tipCents: p.tipCents,
        createdAt: p.createdAt.toISOString(),
        order: {
          id: p.order.id,
          shortCode: p.order.shortCode,
          tableNumber: p.order.table.number,
        },
      }))}
      device={
        device ? { id: device.kushkiDeviceId, label: device.label } : null
      }
    />
  );
}
