import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveContext } from "@/lib/activeRestaurant";
import { computeOrderTotals } from "@/lib/orderTotals";
import { TerminalGrid } from "./TerminalGrid";

export const dynamic = "force-dynamic";

export default async function TerminalPage() {
  const session = await auth();
  const ctx = await getActiveContext();
  const restaurantId = ctx?.restaurantId ?? session?.user?.restaurantId ?? null;
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, slug: true, name: true, serviceMode: true },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  // All tables of the tenant (excluding the pickup virtual table number -1
  // since the terminal can't charge a pickup customer at the table).
  const tables = await db.table.findMany({
    where: { restaurantId: tenant.id, number: { gte: 0 } },
    orderBy: { number: "asc" },
    include: {
      orders: {
        where: { status: { notIn: ["cancelled"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          payments: {
            where: { status: { in: ["approved", "pending"] } },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });

  const devices = await db.terminalDevice.findMany({
    where: { restaurantId: tenant.id, active: true },
    orderBy: { createdAt: "asc" },
  });

  // Pick the device this session is bound to. For now we pick the first
  // active one — in Phase 8 we'll let an admin pin a device per user.
  const device = devices[0] ?? null;

  const cards = tables.map((t) => {
    const order = t.orders[0] ?? null;
    if (!order) {
      return {
        tableId: t.id,
        number: t.number,
        label: t.label,
        state: "free" as const,
        orderId: null,
        shortCode: null,
        subtotalCents: 0,
        outstandingCents: 0,
        paidCents: 0,
        pendingPaymentId: null,
        pendingTerminalAmountCents: null,
        pendingTerminalRequestedAt: null,
        approvedSummaries: [],
      };
    }
    const approved = order.payments.filter((p) => p.status === "approved");
    // Prefer a pending datáfono request over any other pending payment so
    // the "pidió datáfono" highlight always wins. The cashier needs to see
    // that immediately — a pending cash payment can wait.
    const pendingTerminal = order.payments.find(
      (p) => p.status === "pending" && p.method === "kushki_card_terminal",
    );
    const pending = pendingTerminal ?? order.payments.find((p) => p.status === "pending");
    const totals = computeOrderTotals(order.subtotalCents, approved);
    const state:
      | "paid"
      | "terminal_requested"
      | "charging"
      | "partial"
      | "occupied" =
      order.status === "paid"
        ? "paid"
        : pendingTerminal
          ? "terminal_requested"
          : pending
            ? "charging"
            : totals.foodPaidCents > 0
              ? "partial"
              : "occupied";
    return {
      tableId: t.id,
      number: t.number,
      label: t.label,
      state,
      orderId: order.id,
      shortCode: order.shortCode,
      subtotalCents: order.subtotalCents,
      outstandingCents: totals.outstandingCents,
      paidCents: totals.foodPaidCents,
      pendingPaymentId: pending?.id ?? null,
      // What the diner asked the terminal to charge — includes whatever
      // tip they picked. The card shows it next to "pidió datáfono".
      pendingTerminalAmountCents: pendingTerminal
        ? pendingTerminal.amountCents + pendingTerminal.tipCents
        : null,
      pendingTerminalRequestedAt: pendingTerminal
        ? pendingTerminal.createdAt.toISOString()
        : null,
      approvedSummaries: approved.slice(-4).map((p) => ({
        id: p.id,
        method: p.method,
        amountCents: p.amountCents,
        tipCents: p.tipCents,
        settledAt: p.settledAt?.toISOString() ?? null,
      })),
    };
  });

  return (
    <TerminalGrid
      tenantSlug={tenant.slug}
      tenantName={tenant.name}
      tables={cards}
      device={device ? { id: device.kushkiDeviceId, label: device.label } : null}
    />
  );
}
